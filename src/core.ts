import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE, DEFAULT_STEP, loadConfig, type Config, type EnvConfig } from "./config.js";
import {
  composeProjectName,
  provisionDatabases,
  slotDatabaseVars,
  type CreatedDatabase,
} from "./databases.js";
import { detectPorts, type Detection } from "./detect.js";
import { isGenerated, renderEnv } from "./env.js";
import { NocollideError } from "./errors.js";
import { currentWorktree, mainWorktreeRoot, type Worktree } from "./git.js";
import { pathKey } from "./paths.js";
import { isPortFree } from "./ports.js";
import { dropMysqlDatabase } from "./mysql.js";
import { dropDatabase } from "./postgres.js";
import { redact } from "./redact.js";
import { withLock, withRegistry, type Registry, type SlotEntry } from "./registry.js";

export const MAX_SLOTS = 100;
export const DEFAULT_ENV_TO = ".env.local";
const PROVISION_TIMEOUT_MS = 10 * 60_000;

export interface Claim {
  slot: number;
  root: string;
  ports: Record<string, number>;
  databases: Record<string, string>;
  vars: Record<string, string>;
  envFile?: string;
  created: boolean;
  createdDatabases: string[];
  copied: string[];
  warnings: string[];
}

export interface Released {
  slot?: number;
  removedEnv?: string;
  droppedDatabases: string[];
  keptDatabases: string[];
}

export interface Collected {
  removed: SlotEntry[];
  droppedDatabases: string[];
  warnings: string[];
}

export interface SlotRow extends SlotEntry {
  current: boolean;
  exists: boolean;
}

export interface InitResult {
  file: string;
  config: Config;
  detection: Detection;
}

export function slotPorts(config: Config, slot: number): Record<string, number> {
  const ports: Record<string, number> = {};
  for (const [name, base] of Object.entries(config.ports)) ports[name] = base + slot * config.step;
  return ports;
}

export function slotVars(ports: Record<string, number>, slot: number, extra: Record<string, string> = {}): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [name, port] of Object.entries(ports)) vars[name] = String(port);
  Object.assign(vars, extra);
  vars.NOCOLLIDE_SLOT = String(slot);
  return vars;
}

function fitsPortRange(config: Config, slot: number): boolean {
  return Object.values(slotPorts(config, slot)).every((port) => port <= 65535);
}

async function portsFree(ports: Record<string, number>): Promise<boolean> {
  for (const port of Object.values(ports)) {
    if (!(await isPortFree(port))) return false;
  }
  return true;
}

async function findSlot(config: Config, taken: Set<number>): Promise<number> {
  for (let slot = 1; slot < MAX_SLOTS && fitsPortRange(config, slot); slot += 1) {
    if (taken.has(slot)) continue;
    if (await portsFree(slotPorts(config, slot))) return slot;
  }
  throw new NocollideError("No free slot left. Run \"nocollide gc\", stop unused dev servers, or lower the base ports.");
}

function envPath(root: string, env: EnvConfig): string {
  return join(root, env.to);
}

function assertEnvWritable(root: string, env: EnvConfig | undefined, force: boolean): void {
  if (!env || force) return;
  const file = envPath(root, env);
  if (existsSync(file) && !isGenerated(readFileSync(file, "utf8"))) {
    throw new NocollideError(
      `${env.to} already exists and was not written by nocollide. Move its values into ${env.from ?? "a template"} or rerun with --force.`,
    );
  }
}

function readTemplate(roots: string[], from: string | undefined): string {
  if (!from) return "";
  const found = roots.map((root) => join(root, from)).find((file) => existsSync(file));
  return found ? readFileSync(found, "utf8") : "";
}

function writeEnv(root: string, source: string, env: EnvConfig, vars: Record<string, string>, slot: number): string {
  const template = readTemplate([root, source], env.from);
  const file = envPath(root, env);
  writeFileSync(file, renderEnv(template, vars, slot));
  return file;
}

function configFor(worktree: Worktree): { config: Config; source: string } {
  if (!worktree.isMain && !existsSync(join(worktree.root, CONFIG_FILE))) {
    const main = mainWorktreeRoot(worktree.root);
    if (main && existsSync(join(main, CONFIG_FILE))) return { config: loadConfig(main), source: main };
  }
  return { config: loadConfig(worktree.root), source: worktree.root };
}

function keys(worktree: Worktree): { repo: string; worktree: string; gitDir: string } {
  return { repo: pathKey(worktree.repo), worktree: pathKey(worktree.root), gitDir: pathKey(worktree.gitDir) };
}

function mainRootOf(worktree: Worktree): string {
  return worktree.isMain ? worktree.root : (mainWorktreeRoot(worktree.root) ?? worktree.root);
}

const MARKER_FILE = "nocollide-slot";

function readMarker(gitDir: string): string | undefined {
  try {
    return readFileSync(join(gitDir, MARKER_FILE), "utf8").trim();
  } catch {
    return undefined;
  }
}

function writeMarker(worktree: Worktree, entry: SlotEntry): void {
  if (worktree.isMain) return;
  entry.token ??= randomBytes(8).toString("hex");
  if (readMarker(worktree.gitDir) === entry.token) return;
  try {
    writeFileSync(join(worktree.gitDir, MARKER_FILE), `${entry.token}\n`);
  } catch {}
}

function movedHere(entry: SlotEntry): boolean {
  return entry.gitDir !== undefined && entry.token !== undefined && readMarker(entry.gitDir) === entry.token;
}

export function isAlive(entry: SlotEntry): boolean {
  if (existsSync(entry.root)) return true;
  if (!entry.gitDir || !movedHere(entry)) return false;
  try {
    const target = readFileSync(join(entry.gitDir, "gitdir"), "utf8").trim();
    return target !== "" && existsSync(target);
  } catch {
    return false;
  }
}

function slotUsedElsewhere(registry: Registry, repo: string, slot: number): boolean {
  if (slot === 0) return false;
  return Object.entries(registry.repos).some(
    ([other, slots]) => other !== repo && Object.values(slots).some((entry) => entry.slot === slot),
  );
}

function takenSlots(registry: Registry): Set<number> {
  const taken = new Set<number>();
  for (const slots of Object.values(registry.repos)) {
    for (const entry of Object.values(slots)) if (entry.slot > 0) taken.add(entry.slot);
  }
  return taken;
}

interface DropOutcome {
  dropped: string[];
  failed: CreatedDatabase[];
  messages: string[];
}

async function dropAll(databases: CreatedDatabase[] | undefined): Promise<DropOutcome> {
  const outcome: DropOutcome = { dropped: [], failed: [], messages: [] };
  for (const db of databases ?? []) {
    try {
      await (db.kind === "mysql" ? dropMysqlDatabase(db.url) : dropDatabase(db.url));
      outcome.dropped.push(db.url);
    } catch (error) {
      outcome.failed.push(db);
      outcome.messages.push(`Could not drop ${redact(db.url)}: ${redact((error as Error).message)}`);
    }
  }
  return outcome;
}

function removeEntry(registry: Registry, repo: string, id: string): void {
  const slots = registry.repos[repo];
  if (!slots) return;
  delete slots[id];
  if (Object.keys(slots).length === 0) delete registry.repos[repo];
}

export function init(cwd: string, options: { force?: boolean } = {}): InitResult {
  const worktree = currentWorktree(cwd);
  const file = join(worktree.root, CONFIG_FILE);
  if (existsSync(file) && !options.force) {
    throw new NocollideError(`${CONFIG_FILE} already exists. Rerun with --force to replace it.`);
  }
  const detection = detectPorts(worktree.root);
  const env: EnvConfig = detection.envFrom ? { from: detection.envFrom, to: DEFAULT_ENV_TO } : { to: DEFAULT_ENV_TO };
  const config: Config = { ports: detection.ports, step: DEFAULT_STEP, env };
  if (Object.keys(detection.databases).length > 0) config.databases = detection.databases;
  if (detection.compose) config.compose = {};
  const output: Record<string, unknown> = { ...config };
  if (config.compose) output.compose = true;
  writeFileSync(file, `${JSON.stringify(output, null, 2)}\n`);
  return { file, config, detection };
}

export async function up(cwd: string, options: { force?: boolean; writeEnv?: boolean } = {}): Promise<Claim> {
  const worktree = currentWorktree(cwd);
  const { config, source } = configFor(worktree);
  const envConfig = options.writeEnv === false ? undefined : config.env;
  assertEnvWritable(worktree.root, envConfig, options.force ?? false);
  const key = keys(worktree);

  const { slot, created } = await withRegistry(async (registry) => {
    const slots = (registry.repos[key.repo] ??= {});
    let existing = slots[key.worktree];
    if (!existing) {
      const moved = Object.entries(slots).find(
        ([, entry]) =>
          entry.gitDir !== undefined && pathKey(entry.gitDir) === key.gitDir && !existsSync(entry.root) && movedHere(entry),
      );
      if (moved) {
        existing = moved[1];
        delete slots[moved[0]];
        slots[key.worktree] = existing;
      }
    }
    if (
      existing &&
      (!worktree.isMain || existing.slot === 0) &&
      fitsPortRange(config, existing.slot) &&
      !slotUsedElsewhere(registry, key.repo, existing.slot)
    ) {
      existing.root = worktree.root;
      existing.gitDir = worktree.gitDir;
      existing.ports = slotPorts(config, existing.slot);
      writeMarker(worktree, existing);
      return { slot: existing.slot, created: false };
    }
    const carried = existing?.databases;
    delete slots[key.worktree];
    let chosen: number;
    if (worktree.isMain) {
      for (const [other, entry] of Object.entries(slots)) if (entry.slot === 0) delete slots[other];
      chosen = 0;
    } else {
      chosen = await findSlot(config, takenSlots(registry));
    }
    const entry: SlotEntry = {
      slot: chosen,
      root: worktree.root,
      gitDir: worktree.gitDir,
      ports: slotPorts(config, chosen),
      claimedAt: new Date().toISOString(),
    };
    if (carried?.length) entry.databases = carried;
    writeMarker(worktree, entry);
    slots[key.worktree] = entry;
    return { slot: chosen, created: true };
  });

  const mainRoot = mainRootOf(worktree);
  const record = (db: CreatedDatabase) =>
    withRegistry((registry) => {
      const entry = registry.repos[key.repo]?.[key.worktree];
      if (!entry) return;
      entry.databases = [...(entry.databases ?? []).filter((known) => known.url !== db.url), db];
    });
  const owned = () =>
    withRegistry(
      (registry) => new Map((registry.repos[key.repo]?.[key.worktree]?.databases ?? []).map((db) => [db.url, db] as const)),
    );
  const lockName = `provision-${createHash("sha1").update(key.worktree).digest("hex").slice(0, 16)}`;
  const provisioned = config.databases
    ? await withLock(lockName, PROVISION_TIMEOUT_MS, "another nocollide command that is setting up databases for this worktree", () =>
        provisionDatabases(config.databases, slot, worktree.root, mainRoot, owned, record),
      )
    : { created: [], copied: [], warnings: [] };

  const ports = slotPorts(config, slot);
  const databases = slotDatabaseVars(config.databases, slot);
  const extra: Record<string, string> = { ...databases };
  if (config.compose) extra.COMPOSE_PROJECT_NAME = composeProjectName(config.compose, mainRoot, slot);
  const vars = slotVars(ports, slot, extra);
  const claim: Claim = {
    slot,
    root: worktree.root,
    ports,
    databases,
    vars,
    created,
    createdDatabases: provisioned.created.map((db) => db.url),
    copied: provisioned.copied,
    warnings: provisioned.warnings,
  };
  if (envConfig) claim.envFile = writeEnv(worktree.root, source, envConfig, vars, slot);
  return claim;
}

export async function down(cwd: string, options: { keepData?: boolean } = {}): Promise<Released> {
  const worktree = currentWorktree(cwd);
  const key = keys(worktree);
  const entry = await withRegistry((registry) => registry.repos[key.repo]?.[key.worktree]);
  const result: Released = { droppedDatabases: [], keptDatabases: [] };
  let outcome: DropOutcome = { dropped: [], failed: [], messages: [] };
  if (entry) {
    result.slot = entry.slot;
    if (options.keepData) result.keptDatabases = (entry.databases ?? []).map((db) => db.url);
    else outcome = await dropAll(entry.databases);
    result.droppedDatabases = outcome.dropped;
    await withRegistry((registry) => {
      const current = registry.repos[key.repo]?.[key.worktree];
      if (!current) return;
      if (outcome.failed.length > 0) current.databases = outcome.failed;
      else removeEntry(registry, key.repo, key.worktree);
    });
  }
  if (outcome.failed.length > 0) {
    throw new NocollideError(
      `${outcome.messages.join(" ")} The slot stays claimed, so run "nocollide down" again once that is fixed.`,
    );
  }
  let env: EnvConfig | undefined;
  try {
    env = configFor(worktree).config.env;
  } catch {
    env = undefined;
  }
  if (env) {
    const file = envPath(worktree.root, env);
    if (existsSync(file) && isGenerated(readFileSync(file, "utf8"))) {
      rmSync(file);
      result.removedEnv = file;
    }
  }
  return result;
}

export async function list(cwd: string): Promise<SlotRow[]> {
  const worktree = currentWorktree(cwd);
  const key = keys(worktree);
  return withRegistry((registry) =>
    Object.entries(registry.repos[key.repo] ?? {})
      .map(([id, entry]) => ({ ...entry, current: id === key.worktree, exists: isAlive(entry) }))
      .sort((a, b) => a.slot - b.slot),
  );
}

export async function gc(options: { keepData?: boolean } = {}): Promise<Collected> {
  const candidates = await withRegistry((registry) => {
    const found: Array<{ repo: string; id: string; entry: SlotEntry }> = [];
    for (const [repo, slots] of Object.entries(registry.repos)) {
      for (const [id, entry] of Object.entries(slots)) if (!isAlive(entry)) found.push({ repo, id, entry });
    }
    return found.sort((a, b) => a.entry.slot - b.entry.slot);
  });
  const result: Collected = { removed: [], droppedDatabases: [], warnings: [] };
  const outcomes = new Map<string, DropOutcome>();
  for (const candidate of candidates) {
    const outcome: DropOutcome = options.keepData
      ? { dropped: [], failed: [], messages: [] }
      : await dropAll(candidate.entry.databases);
    outcomes.set(`${candidate.repo}\n${candidate.id}`, outcome);
    result.droppedDatabases.push(...outcome.dropped);
    result.warnings.push(...outcome.messages);
  }
  await withRegistry((registry) => {
    for (const candidate of candidates) {
      const current = registry.repos[candidate.repo]?.[candidate.id];
      if (!current || isAlive(current)) continue;
      const outcome = outcomes.get(`${candidate.repo}\n${candidate.id}`)!;
      if (outcome.failed.length > 0) {
        current.databases = outcome.failed;
      } else {
        removeEntry(registry, candidate.repo, candidate.id);
        result.removed.push(candidate.entry);
      }
    }
  });
  return result;
}
