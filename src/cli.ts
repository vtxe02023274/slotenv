#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { down, gc, init, list, up } from "./core.js";
import { doctor } from "./doctor.js";
import { NocollideError } from "./errors.js";
import { redact } from "./redact.js";
import { isIgnored } from "./git.js";
import { installHook, uninstallHook } from "./hook.js";
import { formatVars, parseShell } from "./shell.js";

const version = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string })
  .version;

const HELP = `nocollide ${version}
Run parallel coding agents without collisions.

Usage:
  nocollide init [--force]        Create nocollide.json for this repository
  nocollide up [--force]          Claim a slot for this worktree and write its env file
  nocollide down [--keep-data]    Release the slot of this worktree and drop its databases
  nocollide ls [--json]           List the slots of this repository
  nocollide gc [--keep-data]      Release slots whose worktree was deleted
  nocollide port <NAME>           Print one port of this worktree
  nocollide run -- <command...>   Run a command with the slot variables set
  nocollide env [--shell <name>]  Print the slot variables: sh, powershell, cmd or json
  nocollide hook install          Run "nocollide up" automatically for new worktrees
  nocollide hook uninstall        Remove that hook
  nocollide doctor                Check the setup and say what to fix

Options:
  -h, --help      Show this help
  -v, --version   Show the version
`;

function formatPorts(ports: Record<string, number>): string {
  return Object.entries(ports)
    .map(([name, port]) => `${name}=${port}`)
    .join(" ");
}


function databaseLabel(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol.replace(":", "")} ${decodeURIComponent(url.pathname.slice(1))}`;
  } catch {
    return value;
  }
}

function quoteWindows(arg: string): string {
  return /^[\w\-.:/\\=@,+%]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`;
}

function runCommand(command: string[], vars: Record<string, string>): Promise<number> {
  const env = { ...process.env, ...vars };
  const [file, ...args] = command;
  if (!file) throw new NocollideError('Nothing to run. Usage: nocollide run -- <command...>');
  const child =
    process.platform === "win32"
      ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${command.map(quoteWindows).join(" ")}"`], {
          stdio: "inherit",
          env,
          windowsVerbatimArguments: true,
        })
      : spawn(file, args, { stdio: "inherit", env });
  return new Promise((resolve, reject) => {
    const forward = (signal: NodeJS.Signals) => () => {
      if (child.exitCode === null) child.kill(signal);
    };
    const handlers: Array<[NodeJS.Signals, () => void]> = [
      ["SIGINT", () => undefined],
      ["SIGTERM", forward("SIGTERM")],
      ["SIGHUP", forward("SIGHUP")],
    ];
    for (const [signal, handler] of handlers) process.on(signal, handler);
    const cleanup = () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    };
    child.once("error", (error) => {
      cleanup();
      reject(new NocollideError(`Could not start ${file}: ${error.message}`));
    });
    child.once("exit", (code, signal) => {
      cleanup();
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const own = command === "run" ? [] : rest;
  const flags = new Set(own.filter((arg) => arg.startsWith("-")).map((arg) => arg.split("=")[0]!));
  const option = (name: string): string | undefined => {
    const inline = own.find((arg) => arg.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = own.indexOf(name);
    return index >= 0 ? own[index + 1] : undefined;
  };
  const positional = own.filter((arg, index) => !arg.startsWith("-") && own[index - 1] !== "--shell");
  const force = flags.has("--force") || flags.has("-f");
  const keepData = flags.has("--keep-data");
  const cwd = process.cwd();

  if (!command || command === "-h" || command === "--help" || command === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === "-v" || command === "--version") {
    process.stdout.write(`${version}\n`);
    return 0;
  }

  switch (command) {
    case "init": {
      const { file, config, detection } = init(cwd, { force });
      const source = detection.detected ? "Detected" : "No ports detected, using";
      console.log(`${source} ${formatPorts(config.ports)} (step ${config.step}).`);
      for (const [name, db] of Object.entries(config.databases ?? {})) {
        console.log(`Detected ${db.kind} database ${name}.`);
      }
      if (config.compose) console.log("Detected a Compose file: each slot gets its own COMPOSE_PROJECT_NAME.");
      if (detection.skipped.length > 0) {
        console.log(
          `Left out service ports that should stay shared: ${detection.skipped.join(", ")}. Add them to "ports" if each slot runs its own copy.`,
        );
      }
      console.log(`Wrote ${relative(cwd, file) || file}.`);
      const framework = detection.framework;
      if (framework && !framework.readsPort && "PORT" in config.ports) {
        console.log(`${framework.name} does not read PORT by itself: ${framework.hint}, or use "nocollide run".`);
      }
      if (detection.hardcoded.length > 0) {
        console.log(
          `These scripts hard-code a port: ${detection.hardcoded.join(", ")}. Make them read the variable instead, or start them with "nocollide run -- <command>".`,
        );
      }
      const envTo = config.env?.to;
      if (envTo && !isIgnored(cwd, envTo)) console.log(`Add ${envTo} to .gitignore so slot values are not committed.`);
      return 0;
    }
    case "up": {
      const claim = await up(cwd, { force });
      console.log(`Slot ${claim.slot}${claim.created ? "" : " (already claimed)"} for ${claim.root}`);
      for (const [name, port] of Object.entries(claim.ports)) console.log(`  ${name}=${port}`);
      for (const [name, value] of Object.entries(claim.databases)) console.log(`  ${name}=${redact(value)}`);
      if (claim.vars.COMPOSE_PROJECT_NAME) console.log(`  COMPOSE_PROJECT_NAME=${claim.vars.COMPOSE_PROJECT_NAME}`);
      for (const url of claim.createdDatabases) console.log(`Created database ${databaseLabel(url)}`);
      for (const file of claim.copied) console.log(`Copied ${relative(cwd, file) || file} from the main worktree`);
      for (const warning of claim.warnings) console.log(`Warning: ${warning}`);
      if (claim.envFile) console.log(`Wrote ${relative(cwd, claim.envFile) || claim.envFile}`);
      return 0;
    }
    case "down": {
      const result = await down(cwd, { keepData });
      console.log(result.slot === undefined ? "This worktree had no slot." : `Released slot ${result.slot}.`);
      for (const url of result.droppedDatabases) console.log(`Dropped database ${databaseLabel(url)}`);
      for (const url of result.keptDatabases) console.log(`Kept database ${databaseLabel(url)}`);
      if (result.removedEnv) console.log(`Removed ${relative(cwd, result.removedEnv) || result.removedEnv}`);
      return 0;
    }
    case "ls":
    case "list": {
      const rows = await list(cwd);
      if (flags.has("--json")) {
        const data = rows.map((row) => ({
          slot: row.slot,
          worktree: row.root,
          ports: row.ports,
          databases: (row.databases ?? []).map((db) => redact(db.url)),
          current: row.current,
          exists: row.exists,
          claimedAt: row.claimedAt,
        }));
        process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
        return 0;
      }
      if (rows.length === 0) {
        console.log('No slots claimed in this repository. Run "nocollide up" in a worktree.');
        return 0;
      }
      const width = Math.max(...rows.map((row) => row.root.length), "WORKTREE".length);
      console.log(`SLOT  ${"WORKTREE".padEnd(width)}  PORTS`);
      for (const row of rows) {
        const note = row.current ? "  (here)" : row.exists ? "" : "  (missing, run gc)";
        console.log(`${String(row.slot).padEnd(4)}  ${row.root.padEnd(width)}  ${formatPorts(row.ports)}${note}`);
      }
      return 0;
    }
    case "gc": {
      const result = await gc({ keepData });
      if (result.removed.length === 0) console.log("Nothing to clean.");
      for (const entry of result.removed) console.log(`Released slot ${entry.slot} of ${entry.root}`);
      for (const url of result.droppedDatabases) console.log(`Dropped database ${databaseLabel(url)}`);
      for (const warning of result.warnings) console.log(`Warning: ${warning}`);
      return 0;
    }
    case "port": {
      const name = positional[0];
      if (!name) throw new NocollideError("Usage: nocollide port <NAME>");
      const claim = await up(cwd, { writeEnv: false });
      const port = claim.ports[name];
      if (port === undefined) {
        throw new NocollideError(`Unknown port "${name}". Known: ${Object.keys(claim.ports).join(", ")}`);
      }
      process.stdout.write(`${port}\n`);
      return 0;
    }
    case "run": {
      const commandLine = rest[0] === "--" ? rest.slice(1) : rest;
      const claim = await up(cwd, { writeEnv: false });
      return runCommand(commandLine, claim.vars);
    }
    case "env": {
      const shell = flags.has("--json") ? "json" : parseShell(option("--shell"));
      const claim = await up(cwd, { writeEnv: false });
      process.stdout.write(formatVars(claim.vars, shell));
      return 0;
    }
    case "hook": {
      const action = positional[0];
      if (action === "install") {
        const result = installHook(cwd);
        const how = result.updated ? "Updated" : result.appended ? "Added nocollide to the existing" : "Installed";
        console.log(`${how} ${result.file}. New worktrees now run "nocollide up" when git creates them.`);
        return 0;
      }
      if (action === "uninstall") {
        const result = uninstallHook(cwd);
        if (!result.removed) console.log("The nocollide hook is not installed.");
        else console.log(result.deleted ? `Removed ${result.file}.` : `Removed the nocollide part of ${result.file}.`);
        return 0;
      }
      throw new NocollideError("Usage: nocollide hook install | nocollide hook uninstall");
    }
    case "doctor": {
      const checks = await doctor(cwd);
      const marks = { ok: "ok  ", warn: "warn", fail: "FAIL" } as const;
      for (const check of checks) console.log(`${marks[check.level]}  ${check.message}`);
      return checks.some((check) => check.level === "fail") ? 1 : 0;
    }
    default:
      throw new NocollideError(`Unknown command "${command}". Run "nocollide --help".`);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof NocollideError) {
      console.error(`nocollide: ${redact(error.message)}`);
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  },
);
