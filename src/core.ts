import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CONFIG_FILE, DEFAULT_STEP, configPath, loadConfig, type Config, type EnvConfig } from "./config.js";
import {
  composeProjectName,
  provisionDatabases,
  slotDatabaseVars,
  type CreatedDatabase,
} from "./databases.js";
import { detectPorts, type Detection } from "./detect.js";
import { isGenerated, renderEnv } from "./env.js";
import { SlotenvError } from "./errors.js";
import { currentWorktree, mainWorktreeRoot, worktreeRegistrations, type Worktree } from "./git.js";
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
  vars.SLOTENV_SLOT = String(slot);
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

function portConflict(ports: Record<string, number>, reserved: Set<number>): number | undefined {
  return Object.values(ports).find((port) => reserved.has(port));
}

async function findSlot(config: Config, taken: Set<number>, reserved: Set<number>): Promise<number> {
  for (let slot = 1; slot < MAX_SLOTS && fitsPortRange(config, slot); slot += 1) {
    if (taken.has(slot)) continue;
    const ports = slotPorts(config, slot);
    if (portConflict(ports, reserved) === undefined && await portsFree(ports)) return slot;
  }
  throw new SlotenvError("No free slot left. Run \"slotenv gc\", stop unused dev servers, or lower the base ports.");
}

function isInside(root: string, file: string): boolean {
  const location = relative(root, file);
  return !isAbsolute(location) && location !== ".." && !location.startsWith(`..${sep}`);
}

function envPath(root: string, env: EnvConfig): string {
  const file = resolve(root, env.to);
  const error = () => new SlotenvError(`The env output ${env.to} must be inside the worktree.`);
  if (!isInside(root, file) || !relative(root, file)) throw error();
  let ancestor = file;
  try {
    while (!lstatSync(ancestor, { throwIfNoEntry: false })) ancestor = dirname(ancestor);
    if (isInside(realpathSync.native(root), realpathSync.native(ancestor))) return file;
  } catch {
    throw error();
  }
  throw error();
}

function assertEnvWritable(root: string, env: EnvConfig | undefined, force: boolean): void {
  if (!env) return;
  const file = envPath(root, env);
  if (!force && existsSync(file) && !isGenerated(readFileSync(file, "utf8"))) {
    throw new SlotenvError(
      `${env.to} already exists and was not written by slotenv. Move its values into ${env.from ?? "a template"} or rerun with --force.`,
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
  if (!worktree.isMain && !configPath(worktree.root)) {
    const main = mainWorktreeRoot(worktree.root);
    if (main && configPath(main)) return { config: loadConfig(main), source: main };
  }
  return { config: loadConfig(worktree.root), source: worktree.root };
}

function keys(worktree: Worktree): { repo: string; worktree: string; gitDir: string } {
  return { repo: pathKey(worktree.repo), worktree: pathKey(worktree.root), gitDir: pathKey(worktree.gitDir) };
}

function mainRootOf(worktree: Worktree): string {
  return worktree.isMain ? worktree.root : (mainWorktreeRoot(worktree.root) ?? worktree.root);
}

const MARKER_FILE = "slotenv-slot";
const LEGACY_MARKER_FILE = "nocollide-slot";

function readMarker(gitDir: string): string | undefined {
  for (const name of [MARKER_FILE, LEGACY_MARKER_FILE]) {
    try {
      return readFileSync(join(gitDir, name), "utf8").trim();
    } catch {}
  }
  return undefined;
}

function writeMarker(worktree: Worktree, entry: SlotEntry): void {
  if (worktree.isMain) return;
  entry.token ??= randomBytes(8).toString("hex");
  if (readMarker(worktree.gitDir) === entry.token) return;
  writeFileSync(join(worktree.gitDir, MARKER_FILE), `${entry.token}\n`);
}

function ownsMarker(entry: SlotEntry): boolean {
  return entry.gitDir !== undefined && entry.token !== undefined && readMarker(entry.gitDir) === entry.token;
}

function registeredRoot(entry: SlotEntry): string | undefined {
  if (!entry.gitDir || !ownsMarker(entry)) return undefined;
  try {
    const target = readFileSync(join(entry.gitDir, "gitdir"), "utf8").trim();
    return target ? dirname(resolve(entry.gitDir, target)) : undefined;
  } catch {
    return undefined;
  }
}

export function isAlive(entry: SlotEntry): boolean {
  if (!entry.token) return existsSync(entry.root);
  const root = registeredRoot(entry);
  return root !== undefined && existsSync(join(root, ".git"));
}

function canCollect(repo: string, entry: SlotEntry): boolean {
  if (isAlive(entry)) return false;
  const registrations = worktreeRegistrations(repo);
  if (!registrations) return false;
  const root = registeredRoot(entry);
  const registration = registrations.get(pathKey(root ?? entry.root));
  return !registration || (!registration.locked && registration.prunable);
}

function worktreeClaim(slots: Record<string, SlotEntry>, worktree: Worktree): [string, SlotEntry] | undefined {
  const key = keys(worktree);
  if (worktree.isMain) {
    const entry = slots[key.worktree];
    return entry?.slot === 0 && (!entry.gitDir || pathKey(entry.gitDir) === key.gitDir) ? [key.worktree, entry] : undefined;
  }
  const token = readMarker(worktree.gitDir);
  if (!token) return undefined;
  return Object.entries(slots).find(
    ([, entry]) => entry.gitDir !== undefined && pathKey(entry.gitDir) === key.gitDir && entry.token === token,
  );
}

function relocateClaim(slots: Record<string, SlotEntry>, id: string, entry: SlotEntry): void {
  delete slots[id];
  if (!entry.gitDir && !entry.token && !entry.databases?.length) return;
  const root = registeredRoot(entry);
  const destination = root && pathKey(root);
  if (root && destination && destination !== id && !slots[destination]) {
    entry.root = root;
    slots[destination] = entry;
  } else {
    slots[`orphan-${randomBytes(8).toString("hex")}`] = entry;
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

function reservedPorts(registry: Registry): Set<number> {
  const reserved = new Set<number>();
  for (const slots of Object.values(registry.repos)) {
    for (const entry of Object.values(slots)) {
      for (const port of Object.values(entry.ports)) reserved.add(port);
    }
  }
  return reserved;
}

function assertPortsUnreserved(ports: Record<string, number>, registry: Registry): void {
  const conflict = portConflict(ports, reservedPorts(registry));
  if (conflict !== undefined) throw new SlotenvError(`Port ${conflict} is reserved by another worktree. Release its slot or change the configured ports.`);
}

interface DropOutcome {
  dropped: string[];
  failed: CreatedDatabase[];
  messages: string[];
}

async function dropAll(databases: CreatedDatabase[] | undefined): Promise<DropOutcome> {
  const outcome: DropOutcome = { dropped: [], failed: [], messages: [] };
  for (const db of databases ?? []) {
    if (db.ready === false) continue;
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

function withWorktreeLock<T>(gitDir: string, work: () => Promise<T>): Promise<T> {
  const name = `provision-${createHash("sha1").update(pathKey(gitDir)).digest("hex").slice(0, 16)}`;
  return withLock(name, PROVISION_TIMEOUT_MS, "another slotenv command for this worktree", work);
}

export function init(cwd: string, options: { force?: boolean } = {}): InitResult {
  const worktree = currentWorktree(cwd);
  const file = join(worktree.root, CONFIG_FILE);
  const existing = configPath(worktree.root);
  if (existing && !options.force) {
    throw new SlotenvError(`${basename(existing)} already exists. Rerun with --force to replace it.`);
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
  return withWorktreeLock(worktree.gitDir, () => claimWorktree(worktree, options));
}

async function claimWorktree(worktree: Worktree, options: { force?: boolean; writeEnv?: boolean }): Promise<Claim> {
  const { config, source } = configFor(worktree);
  const envConfig = options.writeEnv === false ? undefined : config.env;
  assertEnvWritable(worktree.root, envConfig, options.force ?? false);
  const key = keys(worktree);

  const { slot, created } = await withRegistry(async (registry) => {
    const slots = (registry.repos[key.repo] ??= {});
    const match = worktreeClaim(slots, worktree);
    const existing = match?.[1];
    const atPath = slots[key.worktree];
    if (match) delete slots[match[0]];
    if (atPath && atPath !== existing) relocateClaim(slots, key.worktree, atPath);
    if (
      existing &&
      (!worktree.isMain || existing.slot === 0) &&
      fitsPortRange(config, existing.slot) &&
      !slotUsedElsewhere(registry, key.repo, existing.slot)
    ) {
      existing.root = worktree.root;
      existing.gitDir = worktree.gitDir;
      existing.ports = slotPorts(config, existing.slot);
      assertPortsUnreserved(existing.ports, registry);
      writeMarker(worktree, existing);
      slots[key.worktree] = existing;
      return { slot: existing.slot, created: false };
    }
    const carried = existing?.databases;
    let chosen: number;
    if (worktree.isMain) {
      for (const [other, entry] of Object.entries(slots)) if (entry.slot === 0) delete slots[other];
      chosen = 0;
      assertPortsUnreserved(slotPorts(config, chosen), registry);
    } else {
      chosen = await findSlot(config, takenSlots(registry), reservedPorts(registry));
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
  const requireClaim = (registry: Registry): SlotEntry => {
    const entry = worktreeClaim(registry.repos[key.repo] ?? {}, worktree)?.[1];
    if (!entry || entry.slot !== slot) throw new SlotenvError("This worktree's slot is no longer claimed. Run \"slotenv up\" again.");
    return entry;
  };
  const record = (url: string, db?: CreatedDatabase) =>
    withRegistry((registry) => {
      const entry = requireClaim(registry);
      entry.databases = (entry.databases ?? []).filter((known) => known.url !== url);
      if (db) entry.databases.push(db);
    });
  const owned = (url: string) => withRegistry((registry) => requireClaim(registry).databases?.find((db) => db.url === url));
  const provisioned = await provisionDatabases(config.databases, slot, worktree.root, mainRoot, owned, record);

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
  return withWorktreeLock(worktree.gitDir, () => releaseWorktree(worktree, options));
}

async function releaseWorktree(worktree: Worktree, options: { keepData?: boolean }): Promise<Released> {
  const key = keys(worktree);
  let env: EnvConfig | undefined;
  try {
    env = configFor(worktree).config.env;
  } catch {
    env = undefined;
  }
  if (env) envPath(worktree.root, env);
  const claim = await withRegistry((registry) => worktreeClaim(registry.repos[key.repo] ?? {}, worktree));
  const result: Released = { droppedDatabases: [], keptDatabases: [] };
  let outcome: DropOutcome = { dropped: [], failed: [], messages: [] };
  if (claim) {
    const [, entry] = claim;
    result.slot = entry.slot;
    if (options.keepData) result.keptDatabases = (entry.databases ?? []).map((db) => db.url);
    else outcome = await dropAll(entry.databases);
    result.droppedDatabases = outcome.dropped;
    await withRegistry((registry) => {
      const match = worktreeClaim(registry.repos[key.repo] ?? {}, worktree);
      if (!match) return;
      const [id, current] = match;
      if (outcome.failed.length > 0) current.databases = outcome.failed;
      else removeEntry(registry, key.repo, id);
    });
  }
  if (outcome.failed.length > 0) {
    throw new SlotenvError(
      `${outcome.messages.join(" ")} The slot stays claimed, so run "slotenv down" again once that is fixed.`,
    );
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
  return withRegistry((registry) => {
    const slots = registry.repos[key.repo] ?? {};
    const current = worktreeClaim(slots, worktree)?.[0];
    return Object.entries(slots)
      .map(([id, entry]) => ({ ...entry, current: id === current, exists: isAlive(entry) }))
      .sort((a, b) => a.slot - b.slot);
  });
}

export async function gc(options: { keepData?: boolean } = {}): Promise<Collected> {
  const candidates = await withRegistry((registry) => {
    const found: Array<{ repo: string; id: string; entry: SlotEntry }> = [];
    for (const [repo, slots] of Object.entries(registry.repos)) {
      for (const [id, entry] of Object.entries(slots)) if (canCollect(repo, entry)) found.push({ repo, id, entry });
    }
    return found.sort((a, b) => a.entry.slot - b.entry.slot);
  });
  const result: Collected = { removed: [], droppedDatabases: [], warnings: [] };
  for (const { repo, id, entry } of candidates) {
    await withWorktreeLock(entry.gitDir ?? entry.root, async () => {
      const currentClaim = (registry: Registry) => {
        const current = registry.repos[repo]?.[id];
        return current?.claimedAt === entry.claimedAt && current.token === entry.token ? current : undefined;
      };
      const current = await withRegistry((registry) => {
        const match = currentClaim(registry);
        return match && canCollect(repo, match) ? match : undefined;
      });
      if (!current) return;
      const outcome: DropOutcome = options.keepData ? { dropped: [], failed: [], messages: [] } : await dropAll(current.databases);
      result.droppedDatabases.push(...outcome.dropped);
      result.warnings.push(...outcome.messages);
      await withRegistry((registry) => {
        const match = currentClaim(registry);
        if (!match) return;
        if (outcome.failed.length > 0) match.databases = outcome.failed;
        else {
          removeEntry(registry, repo, id);
          result.removed.push(current);
        }
      });
    });
  }
  return result;
}
