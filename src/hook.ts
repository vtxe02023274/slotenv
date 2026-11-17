import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { NocollideError } from "./errors.js";

export const HOOK_NAME = "post-checkout";
const START = "# >>> nocollide >>>";
const END = "# <<< nocollide <<<";

export const HOOK_BLOCK = [
  START,
  'case "$1" in',
  "  *[!0]*) ;;",
  "  *)",
  '    if [ "$3" = "1" ]; then',
  "      if command -v nocollide >/dev/null 2>&1; then",
  "        nocollide up || true",
  "      else",
  "        npx --yes nocollide up || true",
  "      fi",
  "    fi",
  "    ;;",
  "esac",
  END,
].join("\n");

const BLOCK_PATTERN = new RegExp(`${START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${END}\\n?`);

export interface HookLocation {
  file: string;
  husky: boolean;
}

export function hookLocation(cwd: string): HookLocation {
  let dir: string;
  try {
    dir = execFileSync("git", ["rev-parse", "--git-path", "hooks"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    throw new NocollideError("Not inside a git worktree.");
  }
  const hooks = resolve(cwd, dir);
  if (basename(hooks) === "_" && basename(dirname(hooks)) === ".husky") {
    return { file: join(dirname(hooks), HOOK_NAME), husky: true };
  }
  return { file: join(hooks, HOOK_NAME), husky: false };
}

export function hookPath(cwd: string): string {
  return hookLocation(cwd).file;
}

export function hookInstalled(cwd: string): boolean {
  const file = hookPath(cwd);
  return existsSync(file) && readFileSync(file, "utf8").includes(START);
}

function insertAfterShebang(content: string): string {
  if (!content.startsWith("#!")) return `${HOOK_BLOCK}\n${content}`;
  const end = content.indexOf("\n");
  if (end < 0) return `${content}\n${HOOK_BLOCK}\n`;
  return `${content.slice(0, end + 1)}${HOOK_BLOCK}\n${content.slice(end + 1)}`;
}

export function installHook(cwd: string): { file: string; updated: boolean; appended: boolean; husky: boolean } {
  const { file, husky } = hookLocation(cwd);
  mkdirSync(dirname(file), { recursive: true });
  if (!existsSync(file)) {
    writeFileSync(file, husky ? `${HOOK_BLOCK}\n` : `#!/bin/sh\n${HOOK_BLOCK}\n`);
    chmodSync(file, 0o755);
    return { file, updated: false, appended: false, husky };
  }
  const current = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const shebang = current.startsWith("#!") ? (current.split("\n", 1)[0] ?? "") : "";
  if (shebang && !/\b(sh|bash|zsh|dash)\b/.test(shebang)) {
    throw new NocollideError(
      `${file} is not a shell script (${shebang}). Add "nocollide up" to it yourself, or remove it and run "nocollide hook install" again.`,
    );
  }
  const updated = current.includes(START);
  const without = current.replace(BLOCK_PATTERN, "");
  const base = shebang || husky ? without : `#!/bin/sh\n${without}`;
  writeFileSync(file, insertAfterShebang(base));
  chmodSync(file, 0o755);
  return { file, updated, appended: !updated, husky };
}

export function uninstallHook(cwd: string): { file: string; removed: boolean; deleted: boolean } {
  const file = hookPath(cwd);
  if (!existsSync(file)) return { file, removed: false, deleted: false };
  const current = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  if (!current.includes(START)) return { file, removed: false, deleted: false };
  const rest = current.replace(BLOCK_PATTERN, "");
  if (/^(#![^\n]*)?\s*$/.test(rest)) {
    rmSync(file);
    return { file, removed: true, deleted: true };
  }
  writeFileSync(file, rest.replace(/\n*$/, "\n"));
  return { file, removed: true, deleted: false };
}
