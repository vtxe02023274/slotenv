import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { CreatedDatabase } from "./databases.js";
import { NocollideError } from "./errors.js";

export interface SlotEntry {
  slot: number;
  root: string;
  gitDir?: string;
  ports: Record<string, number>;
  claimedAt: string;
  databases?: CreatedDatabase[];
}

export interface Registry {
  version: 1;
  repos: Record<string, Record<string, SlotEntry>>;
}

const REGISTRY_TIMEOUT_MS = 15_000;
const STALE_LOCK_MS = 10_000;
const OWNER_FILE = "owner";

export function homeDir(): string {
  return process.env.NOCOLLIDE_HOME || join(homedir(), ".nocollide");
}

function registryFile(dir: string): string {
  return join(dir, "slots.json");
}

function read(dir: string): Registry {
  const file = registryFile(dir);
  if (!existsSync(file)) return { version: 1, repos: {} };
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as Registry;
    if (data.version !== 1 || typeof data.repos !== "object" || data.repos === null) throw new Error("unknown format");
    return data;
  } catch (error) {
    throw new NocollideError(`The slot registry ${file} is unreadable (${(error as Error).message}). Fix or delete it.`);
  }
}

function write(dir: string, registry: Registry): void {
  const file = registryFile(dir);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(registry, null, 2)}\n`);
  renameSync(temp, file);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isStale(lock: string): boolean {
  let owner: number | undefined;
  try {
    owner = Number(readFileSync(join(lock, OWNER_FILE), "utf8"));
  } catch {
    owner = undefined;
  }
  if (owner && Number.isInteger(owner) && owner !== process.pid) return !processAlive(owner);
  return Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS;
}

async function acquire(lock: string, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, OWNER_FILE), String(process.pid));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    try {
      if (isStale(lock)) {
        const taken = `${lock}.stale-${process.pid}-${Math.random().toString(36).slice(2)}`;
        renameSync(lock, taken);
        rmSync(taken, { recursive: true, force: true });
        continue;
      }
    } catch {
      continue;
    }
    if (Date.now() > deadline) {
      throw new NocollideError(`Timed out waiting for ${what} (${lock}). If no other nocollide command is running, delete that folder.`);
    }
    await sleep(20 + Math.floor(Math.random() * 40));
  }
}

export async function withLock<T>(name: string, timeoutMs: number, what: string, work: () => Promise<T>): Promise<T> {
  const dir = homeDir();
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, `${name}.lock`);
  await acquire(lock, timeoutMs, what);
  try {
    return await work();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export async function withRegistry<T>(update: (registry: Registry) => T | Promise<T>): Promise<T> {
  const dir = homeDir();
  return withLock("registry", REGISTRY_TIMEOUT_MS, "the slot registry", async () => {
    const registry = read(dir);
    const result = await update(registry);
    write(dir, registry);
    return result;
  });
}
