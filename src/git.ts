import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { SlotenvError } from "./errors.js";
import { pathKey } from "./paths.js";

export interface Worktree {
  root: string;
  repo: string;
  gitDir: string;
  isMain: boolean;
}

export function currentWorktree(cwd: string): Worktree {
  let output: string;
  try {
    output = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "--git-dir"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {
    throw new SlotenvError("Not inside a git worktree.");
  }
  const [root, common, dir] = output.trim().split(/\r?\n/);
  if (!root || !common || !dir) {
    throw new SlotenvError("Could not read the worktree layout from git.");
  }
  return {
    root: resolve(root),
    repo: resolve(common),
    gitDir: resolve(dir),
    isMain: pathKey(common) === pathKey(dir),
  };
}

export function mainWorktreeRoot(cwd: string): string | undefined {
  try {
    const output = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const first = output.split(/\r?\n/).find((line) => line.startsWith("worktree "));
    return first ? resolve(first.slice("worktree ".length)) : undefined;
  } catch {
    return undefined;
  }
}

export function worktreeRegistrations(gitDir: string): Map<string, { locked: boolean; prunable: boolean }> | undefined {
  try {
    const output = execFileSync("git", ["--git-dir", gitDir, "worktree", "list", "--porcelain", "-z"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const registrations = new Map<string, { locked: boolean; prunable: boolean }>();
    for (const record of output.split("\0\0")) {
      const [head, ...fields] = record.split("\0");
      if (!head?.startsWith("worktree ")) continue;
      const labels = fields.map((field) => field.split(" ", 1)[0]);
      registrations.set(pathKey(head.slice("worktree ".length)), {
        locked: labels.includes("locked"),
        prunable: labels.includes("prunable"),
      });
    }
    return registrations.size ? registrations : undefined;
  } catch {
    return undefined;
  }
}

export function isIgnored(root: string, file: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", file], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
