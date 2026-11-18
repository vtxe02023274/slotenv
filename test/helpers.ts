import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isPortFree } from "../src/ports.js";

export const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

export interface Sandbox {
  dir: string;
  repo: string;
  home: string;
  cleanup: () => void;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

const SLOTS_CHECKED = 10;
const used = new Set<number>();

export async function freeBase(offsets: number[] = [0]): Promise<number> {
  const stripe = process.pid % 30;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const base = 20000 + (stripe * 10 + Math.floor(Math.random() * 10) + attempt * 30) % 300 * 100;
    if (used.has(base)) continue;
    let free = true;
    for (const offset of offsets) {
      for (let slot = 0; slot < SLOTS_CHECKED && free; slot += 1) free = await isPortFree(base + offset + slot * 10);
    }
    if (free) {
      used.add(base);
      return base;
    }
  }
  throw new Error("No free port range for the test");
}

export function sandbox(files: Record<string, string> = {}): Sandbox {
  const dir = realpathSync.native(mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), "slotenv-")));
  const repo = join(dir, "repo");
  const home = join(dir, "home");
  mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "test\n");
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, name)), { recursive: true });
    writeFileSync(join(repo, name), content);
  }
  git(repo, ["add", "-A"]);
  const tree = git(repo, ["write-tree"]);
  const revision = git(repo, ["commit-tree", tree, "-m", "init"]);
  git(repo, ["update-ref", "HEAD", revision]);
  process.env.SLOTENV_HOME = home;
  return { dir, repo, home, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function addWorktree(box: Sandbox, name: string): string {
  const path = join(box.dir, name);
  git(box.repo, ["worktree", "add", "-q", "-b", name, path]);
  return path;
}

export function removeWorktree(box: Sandbox, path: string): void {
  git(box.repo, ["worktree", "remove", "--force", path]);
}

export function config(ports: Record<string, number>, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ ports, step: 10, env: { from: ".env.example", to: ".env.local" }, ...extra }, null, 2)}\n`;
}

export function runCli(
  cwd: string,
  args: string[],
  home: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { cwd, env: { ...process.env, SLOTENV_HOME: home, FORCE_COLOR: "1" } },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}
