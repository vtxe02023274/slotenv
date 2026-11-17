import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE, LEGACY_CONFIG_FILE, configPath, loadConfig, type Config } from "./config.js";
import { currentWorktree, isIgnored, mainWorktreeRoot } from "./git.js";
import { isAlive } from "./core.js";
import { hookInstalled } from "./hook.js";
import { pathKey } from "./paths.js";
import { withRegistry } from "./registry.js";

export type CheckLevel = "ok" | "warn" | "fail";

export interface Check {
  level: CheckLevel;
  message: string;
}

const MIN_GIT: [number, number] = [2, 31];

function hasCommand(command: string): boolean {
  try {
    execFileSync(command, ["--version"], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export function gitVersion(): [number, number] | undefined {
  try {
    const output = execFileSync("git", ["--version"], { encoding: "utf8" });
    const match = /(\d+)\.(\d+)/.exec(output);
    return match ? [Number(match[1]), Number(match[2])] : undefined;
  } catch {
    return undefined;
  }
}

export async function doctor(cwd: string): Promise<Check[]> {
  const checks: Check[] = [];
  const version = gitVersion();
  if (!version) {
    checks.push({ level: "fail", message: "git was not found on the PATH." });
    return checks;
  }
  const oldGit = version[0] < MIN_GIT[0] || (version[0] === MIN_GIT[0] && version[1] < MIN_GIT[1]);
  checks.push(
    oldGit
      ? { level: "fail", message: `git ${version.join(".")} is too old. slotenv needs git ${MIN_GIT.join(".")} or newer.` }
      : { level: "ok", message: `git ${version.join(".")}` },
  );

  let worktree;
  try {
    worktree = currentWorktree(cwd);
  } catch {
    checks.push({ level: "fail", message: "Not inside a git worktree." });
    return checks;
  }

  const main = worktree.isMain ? worktree.root : mainWorktreeRoot(worktree.root);
  const configRoot = [worktree.root, main].find((root) => root && configPath(root));
  let config: Config | undefined;
  if (!configRoot) {
    checks.push({ level: "fail", message: `No ${CONFIG_FILE}. Run "slotenv init".` });
  } else {
    try {
      config = loadConfig(configRoot);
      const where = configRoot === worktree.root ? "" : " (from the main worktree; commit it so every branch has it)";
      checks.push({ level: configRoot === worktree.root ? "ok" : "warn", message: `${CONFIG_FILE} is valid${where}` });
      if (configPath(configRoot)?.endsWith(LEGACY_CONFIG_FILE)) {
        checks.push({ level: "warn", message: `Rename ${LEGACY_CONFIG_FILE} to ${CONFIG_FILE}. The old name still works for now.` });
      }
    } catch (error) {
      checks.push({ level: "fail", message: (error as Error).message });
    }
  }

  if (config?.env) {
    checks.push(
      isIgnored(worktree.root, config.env.to)
        ? { level: "ok", message: `${config.env.to} is ignored by git` }
        : { level: "warn", message: `${config.env.to} is not in .gitignore, so slot values could be committed.` },
    );
  }

  const kinds = new Set(Object.values(config?.databases ?? {}).map((db) => db.kind));
  if (kinds.has("postgres")) {
    checks.push(
      hasCommand("psql")
        ? { level: "ok", message: "psql is on the PATH" }
        : { level: "fail", message: "Postgres databases need psql on the PATH. Install the Postgres client tools." },
    );
  }

  if (kinds.has("mysql")) {
    const tools = ["mysql", "mysqldump"].filter((tool) => !hasCommand(tool));
    checks.push(
      tools.length === 0
        ? { level: "ok", message: "mysql and mysqldump are on the PATH" }
        : { level: "fail", message: `MySQL databases need ${tools.join(" and ")} on the PATH. Install the MySQL client tools.` },
    );
  }

  checks.push(
    hookInstalled(worktree.root)
      ? { level: "ok", message: "post-checkout hook runs \"slotenv up\" for new worktrees" }
      : { level: "warn", message: 'No hook yet. Run "slotenv hook install" so new worktrees get a slot automatically.' },
  );

  const repo = pathKey(worktree.repo);
  const here = pathKey(worktree.root);
  const slots = await withRegistry((registry) => Object.entries(registry.repos[repo] ?? {}));
  const missing = slots.filter(([, entry]) => !isAlive(entry));
  if (missing.length > 0) {
    checks.push({ level: "warn", message: `${missing.length} slot(s) belong to deleted worktrees. Run "slotenv gc".` });
  }
  const mine = slots.find(([id]) => id === here)?.[1];
  checks.push(
    mine
      ? { level: "ok", message: `This worktree has slot ${mine.slot}` }
      : { level: "warn", message: 'This worktree has no slot yet. Run "slotenv up".' },
  );
  return checks;
}
