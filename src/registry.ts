import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { CreatedDatabase } from "./databases.js";
import { SlotenvError } from "./errors.js";

export interface SlotEntry {
  slot: number;
  root: string;
  gitDir?: string;
  token?: string;
  ports: Record<string, number>;
  claimedAt: string;
  databases?: CreatedDatabase[];
}

export interface Registry {
  version: 1;
  repos: Record<string, Record<string, SlotEntry>>;
}

const REGISTRY_TIMEOUT_MS = 45_000;
const STALE_LOCK_MS = 30_000;
const HEARTBEAT_MS = 5_000;
const TAKEOVER_STALE_MS = 5_000;
const OWNER_FILE = "owner";

export function homeDir(): string {
  const explicit = process.env.SLOTENV_HOME || process.env.NOCOLLIDE_HOME;
  if (explicit) return explicit;
  const home = join(homedir(), ".slotenv");
  const legacy = join(homedir(), ".nocollide");
  return !existsSync(home) && existsSync(legacy) ? legacy : home;
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
    throw new SlotenvError(`The slot registry ${file} is unreadable (${(error as Error).message}). Fix or delete it.`);
  }
}

function write(dir: string, registry: Registry): void {
  const file = registryFile(dir);
  const temp = `${file}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temp, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600, flag: "wx" });
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

function ageOf(path: string): number {
  return Date.now() - statSync(path).mtimeMs;
}

function readOwner(lock: string): { pid: number; token: string } | undefined {
  try {
    const [pid, token] = readFileSync(join(lock, OWNER_FILE), "utf8").trim().split(" ");
    return pid && token ? { pid: Number(pid), token } : undefined;
  } catch {
    return undefined;
  }
}

function isStale(lock: string): boolean {
  const owner = readOwner(lock);
  if (!owner) return ageOf(lock) > STALE_LOCK_MS;
  if (owner.pid !== process.pid && !processAlive(owner.pid)) return true;
  return ageOf(join(lock, OWNER_FILE)) > STALE_LOCK_MS;
}

function takeOver(lock: string): void {
  const guard = `${lock}.takeover`;
  try {
    mkdirSync(guard);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (ageOf(guard) > TAKEOVER_STALE_MS) rmSync(guard, { recursive: true, force: true });
    return;
  }
  try {
    if (existsSync(lock) && isStale(lock)) {
      const taken = `${lock}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
      renameSync(lock, taken);
      rmSync(taken, { recursive: true, force: true });
    }
  } finally {
    rmSync(guard, { recursive: true, force: true });
  }
}

async function acquire(lock: string, timeoutMs: number, what: string): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const token = randomBytes(8).toString("hex");
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, OWNER_FILE), `${process.pid} ${token}`);
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    try {
      if (isStale(lock)) {
        takeOver(lock);
        continue;
      }
    } catch {
      continue;
    }
    if (Date.now() > deadline) {
      throw new SlotenvError(`Timed out waiting for ${what} (${lock}). If no other slotenv command is running, delete that folder.`);
    }
    await sleep(20 + Math.floor(Math.random() * 40));
  }
}

function release(lock: string, token: string): void {
  if (readOwner(lock)?.token === token) rmSync(lock, { recursive: true, force: true });
}

export async function withLock<T>(name: string, timeoutMs: number, what: string, work: () => Promise<T>): Promise<T> {
  const dir = homeDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, `${name}.lock`);
  const token = await acquire(lock, timeoutMs, what);
  const heartbeat = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(join(lock, OWNER_FILE), now, now);
    } catch {}
  }, HEARTBEAT_MS);
  heartbeat.unref();
  try {
    return await work();
  } finally {
    clearInterval(heartbeat);
    release(lock, token);
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
