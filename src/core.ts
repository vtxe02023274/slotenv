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
import { withRegistry, type SlotEntry } from "./registry.js";

export const MAX_SLOTS = 100;
export const DEFAULT_ENV_TO = ".env.local";

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

function keys(worktree: Worktree): { repo: string; worktree: string } {
  return { repo: pathKey(worktree.repo), worktree: pathKey(worktree.root) };
}

function mainRootOf(worktree: Worktree): string {
  return worktree.isMain ? worktree.root : (mainWorktreeRoot(worktree.root) ?? worktree.root);
}

async function dropAll(databases: CreatedDatabase[] | undefined): Promise<{ dropped: string[]; failed: string[] }> {
  const dropped: string[] = [];
  const failed: string[] = [];
  for (const db of databases ?? []) {
    try {
      await (db.kind === "mysql" ? dropMysqlDatabase(db.url) : dropDatabase(db.url));
      dropped.push(db.url);
    } catch (error) {
      failed.push(`Could not drop ${db.url}: ${(error as Error).message}`);
    }
  }
  return { dropped, failed };
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

export async function up(cwd: string, options: { force?: boolean } = {}): Promise<Claim> {
  const worktree = currentWorktree(cwd);
  const { config, source } = configFor(worktree);
  assertEnvWritable(worktree.root, config.env, options.force ?? false);
  const key = keys(worktree);

  const { slot, created } = await withRegistry(async (registry) => {
    const slots = (registry.repos[key.repo] ??= {});
    const existing = slots[key.worktree];
    if (existing && (!worktree.isMain || existing.slot === 0) && fitsPortRange(config, existing.slot)) {
      existing.root = worktree.root;
      existing.ports = slotPorts(config, existing.slot);
      return { slot: existing.slot, created: false };
    }
    delete slots[key.worktree];
    let chosen: number;
    if (worktree.isMain) {
      for (const [other, entry] of Object.entries(slots)) if (entry.slot === 0) delete slots[other];
      chosen = 0;
    } else {
      chosen = await findSlot(config, new Set(Object.values(slots).map((entry) => entry.slot)));
    }
    slots[key.worktree] = {
      slot: chosen,
      root: worktree.root,
      ports: slotPorts(config, chosen),
      claimedAt: new Date().toISOString(),
    };
    return { slot: chosen, created: true };
  });

  const mainRoot = mainRootOf(worktree);
  const provisioned = await provisionDatabases(config.databases, slot, worktree.root, mainRoot);
  if (provisioned.created.length > 0) {
    await withRegistry((registry) => {
      const entry = registry.repos[key.repo]?.[key.worktree];
      if (!entry) return;
      const known = new Set((entry.databases ?? []).map((db) => db.url));
      entry.databases = [...(entry.databases ?? []), ...provisioned.created.filter((db) => !known.has(db.url))];
    });
  }

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
  if (config.env) claim.envFile = writeEnv(worktree.root, source, config.env, vars, slot);
  return claim;
}

export async function down(cwd: string, options: { keepData?: boolean } = {}): Promise<Released> {
  const worktree = currentWorktree(cwd);
  const key = keys(worktree);
  const entry = await withRegistry((registry) => {
    const slots = registry.repos[key.repo];
    const found = slots?.[key.worktree];
    if (!slots || !found) return undefined;
    delete slots[key.worktree];
    if (Object.keys(slots).length === 0) delete registry.repos[key.repo];
    return found;
  });
  const result: Released = { droppedDatabases: [], keptDatabases: [] };
  let failed: string[] = [];
  if (entry) {
    result.slot = entry.slot;
    if (options.keepData) {
      result.keptDatabases = (entry.databases ?? []).map((db) => db.url);
    } else {
      const outcome = await dropAll(entry.databases);
      result.droppedDatabases = outcome.dropped;
      failed = outcome.failed;
    }
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
  if (failed.length > 0) throw new NocollideError(`Released slot ${result.slot}, but: ${failed.join(" ")}`);
  return result;
}

export async function list(cwd: string): Promise<SlotRow[]> {
  const worktree = currentWorktree(cwd);
  const key = keys(worktree);
  return withRegistry((registry) =>
    Object.entries(registry.repos[key.repo] ?? {})
      .map(([id, entry]) => ({ ...entry, current: id === key.worktree, exists: existsSync(entry.root) }))
      .sort((a, b) => a.slot - b.slot),
  );
}

export async function gc(options: { keepData?: boolean } = {}): Promise<Collected> {
  const removed = await withRegistry((registry) => {
    const found: SlotEntry[] = [];
    for (const [repo, slots] of Object.entries(registry.repos)) {
      for (const [id, entry] of Object.entries(slots)) {
        if (!existsSync(entry.root)) {
          found.push(entry);
          delete slots[id];
        }
      }
      if (Object.keys(slots).length === 0) delete registry.repos[repo];
    }
    return found.sort((a, b) => a.slot - b.slot);
  });
  const result: Collected = { removed, droppedDatabases: [], warnings: [] };
  if (!options.keepData) {
    for (const entry of removed) {
      const { dropped, failed } = await dropAll(entry.databases);
      result.droppedDatabases.push(...dropped);
      result.warnings.push(...failed);
    }
  }
  return result;
}
