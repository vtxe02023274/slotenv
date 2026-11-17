import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { NocollideError } from "./errors.js";

export const HOOK_NAME = "post-checkout";
const START = "# >>> nocollide >>>";
const END = "# <<< nocollide <<<";
const NULL_SHA = "0000000000000000000000000000000000000000";

export const HOOK_BLOCK = [
  START,
  `if [ "$1" = "${NULL_SHA}" ] && [ "$3" = "1" ]; then`,
  "  if command -v nocollide >/dev/null 2>&1; then",
  "    nocollide up || true",
  "  else",
  "    npx --yes nocollide up || true",
  "  fi",
  "fi",
  END,
].join("\n");

const BLOCK_PATTERN = new RegExp(`\\n?${START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${END}\\n?`);

export function hookPath(cwd: string): string {
  let dir: string;
  try {
    dir = execFileSync("git", ["rev-parse", "--git-path", "hooks"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    throw new NocollideError("Not inside a git worktree.");
  }
  return join(resolve(cwd, dir), HOOK_NAME);
}

export function hookInstalled(cwd: string): boolean {
  const file = hookPath(cwd);
  return existsSync(file) && readFileSync(file, "utf8").includes(START);
}

export function installHook(cwd: string): { file: string; updated: boolean; appended: boolean } {
  const file = hookPath(cwd);
  mkdirSync(join(file, ".."), { recursive: true });
  if (!existsSync(file)) {
    writeFileSync(file, `#!/bin/sh\n${HOOK_BLOCK}\n`);
    chmodSync(file, 0o755);
    return { file, updated: false, appended: false };
  }
  const current = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  if (current.includes(START)) {
    writeFileSync(file, current.replace(BLOCK_PATTERN, `\n${HOOK_BLOCK}\n`));
    return { file, updated: true, appended: false };
  }
  const shebang = current.split("\n", 1)[0] ?? "";
  if (shebang.startsWith("#!") && !/\b(sh|bash|zsh|dash)\b/.test(shebang)) {
    throw new NocollideError(
      `${file} is not a shell script (${shebang}). Add "nocollide up" to it yourself, or remove it and run "nocollide hook install" again.`,
    );
  }
  const base = shebang.startsWith("#!") ? current : `#!/bin/sh\n${current}`;
  writeFileSync(file, `${base.replace(/\n*$/, "\n")}\n${HOOK_BLOCK}\n`);
  chmodSync(file, 0o755);
  return { file, updated: false, appended: true };
}

export function uninstallHook(cwd: string): { file: string; removed: boolean; deleted: boolean } {
  const file = hookPath(cwd);
  if (!existsSync(file)) return { file, removed: false, deleted: false };
  const current = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  if (!current.includes(START)) return { file, removed: false, deleted: false };
  const rest = current.replace(BLOCK_PATTERN, "\n");
  if (/^(#![^\n]*)?\s*$/.test(rest)) {
    rmSync(file);
    return { file, removed: true, deleted: true };
  }
  writeFileSync(file, rest.replace(/\n*$/, "\n"));
  return { file, removed: true, deleted: false };
}
