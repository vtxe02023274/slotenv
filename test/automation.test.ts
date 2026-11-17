import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { detectPorts } from "../src/detect.js";
import { HOOK_BLOCK, hookPath, installHook, uninstallHook } from "../src/hook.js";
import { formatVars, parseShell } from "../src/shell.js";
import { CLI, addWorktree, config, freeBase, runCli, sandbox } from "./helpers.js";

test("hook install writes, updates and uninstalls a marked block", (t) => {
  const box = sandbox();
  t.after(box.cleanup);
  const first = installHook(box.repo);
  assert.equal(first.file, hookPath(box.repo));
  assert.equal(readFileSync(first.file, "utf8"), `#!/bin/sh\n${HOOK_BLOCK}\n`);
  assert.equal(installHook(box.repo).updated, true);
  assert.equal(readFileSync(first.file, "utf8").split(">>> nocollide >>>").length, 2);
  assert.deepEqual(uninstallHook(box.repo), { file: first.file, removed: true, deleted: true });
  assert.equal(existsSync(first.file), false);
  assert.equal(uninstallHook(box.repo).removed, false);
});

test("hook install keeps an existing hook and respects core.hooksPath", (t) => {
  const box = sandbox();
  t.after(box.cleanup);
  execFileSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: box.repo });
  mkdirSync(join(box.repo, ".githooks"));
  const file = join(box.repo, ".githooks", "post-checkout");
  writeFileSync(file, "#!/usr/bin/env bash\necho mine\n");
  assert.equal(hookPath(box.repo), file);
  assert.equal(installHook(box.repo).appended, true);
  const content = readFileSync(file, "utf8");
  assert.ok(content.startsWith("#!/usr/bin/env bash\necho mine\n"));
  assert.ok(content.includes(HOOK_BLOCK));
  assert.deepEqual(uninstallHook(box.repo), { file, removed: true, deleted: false });
  assert.equal(readFileSync(file, "utf8"), "#!/usr/bin/env bash\necho mine\n");

  writeFileSync(file, "#!/usr/bin/env node\nconsole.log(1)\n");
  assert.throws(() => installHook(box.repo), /not a shell script/);
});

test("with the hook, git worktree add claims a slot by itself", async (t) => {
  const base = await freeBase();
  const box = sandbox({ "nocollide.json": config({ WEB_PORT: base }), ".gitignore": ".env.local\n" });
  t.after(box.cleanup);
  const bin = join(box.dir, "bin");
  mkdirSync(bin);
  const shim = join(bin, "nocollide");
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath.replace(/\\/g, "/")}" "${CLI.replace(/\\/g, "/")}" "$@"\n`);
  chmodSync(shim, 0o755);
  installHook(box.repo);
  const path = join(box.dir, "auto");
  execFileSync("git", ["worktree", "add", "-q", "-b", "auto", path], {
    cwd: box.repo,
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, NOCOLLIDE_HOME: box.home },
    stdio: "ignore",
  });
  const env = readFileSync(join(path, ".env.local"), "utf8");
  assert.match(env, new RegExp(`^WEB_PORT=${base + 10}$`, "m"));
});

test("env prints variables for each shell", () => {
  const vars = { WEB_PORT: "3010", NOTE: "it's" };
  assert.equal(formatVars(vars, "sh"), "export WEB_PORT='3010'\nexport NOTE='it'\\''s'\n");
  assert.equal(formatVars(vars, "powershell"), "$env:WEB_PORT = '3010'\n$env:NOTE = 'it''s'\n");
  assert.equal(formatVars(vars, "cmd"), 'set "WEB_PORT=3010"\nset "NOTE=it\'s"\n');
  assert.deepEqual(JSON.parse(formatVars(vars, "json")), vars);
  assert.equal(parseShell("zsh"), "sh");
  assert.equal(parseShell("pwsh"), "powershell");
  assert.throws(() => parseShell("tcsh"), /Unknown shell/);
});

test("env --json and ls --json from the CLI", async (t) => {
  const base = await freeBase();
  const box = sandbox({ "nocollide.json": config({ WEB_PORT: base }) });
  t.after(box.cleanup);
  const worktree = addWorktree(box, "json");
  const env = await runCli(worktree, ["env", "--json"], box.home);
  assert.equal(env.code, 0, env.stderr);
  assert.deepEqual(JSON.parse(env.stdout), { WEB_PORT: String(base + 10), NOCOLLIDE_SLOT: "1" });
  const sh = await runCli(worktree, ["env", "--shell", "sh"], box.home);
  assert.match(sh.stdout, new RegExp(`^export WEB_PORT='${base + 10}'$`, "m"));
  const ls = await runCli(worktree, ["ls", "--json"], box.home);
  const rows = JSON.parse(ls.stdout);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].slot, 1);
  assert.equal(rows[0].current, true);
  assert.deepEqual(rows[0].ports, { WEB_PORT: base + 10 });
});

test("flags after -- belong to the command, not to nocollide", async (t) => {
  const box = sandbox({
    "nocollide.json": config({ WEB_PORT: await freeBase() }),
    "args.js": "console.log(process.argv.slice(2).join(' '))\n",
  });
  t.after(box.cleanup);
  const result = await runCli(addWorktree(box, "args"), ["run", "--", "node", "args.js", "--force", "--json"], box.home);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), "--force --json");
});

test("init falls back to framework default ports", (t) => {
  const cases: Array<[Record<string, string>, number, string]> = [
    [{ "package.json": JSON.stringify({ devDependencies: { vite: "^6" } }) }, 5173, "Vite"],
    [{ "package.json": JSON.stringify({ dependencies: { next: "^15", react: "^19" } }) }, 3000, "Next.js"],
    [{ "package.json": JSON.stringify({ dependencies: { astro: "^5" } }) }, 4321, "Astro"],
    [{ "manage.py": "" }, 8000, "Django"],
    [{ "requirements.txt": "Flask==3.0\n" }, 5000, "Flask"],
    [{ Gemfile: 'gem "rails", "~> 8.0"\n' }, 3000, "Rails"],
  ];
  for (const [files, port, name] of cases) {
    const box = sandbox(files);
    t.after(box.cleanup);
    const detection = detectPorts(box.repo);
    assert.deepEqual(detection.ports, { PORT: port }, name);
    assert.equal(detection.framework?.name, name);
    assert.equal(detection.detected, true);
  }
  const explicit = sandbox({
    "package.json": JSON.stringify({ scripts: { dev: "vite --port 4000" }, devDependencies: { vite: "^6" } }),
  });
  t.after(explicit.cleanup);
  assert.deepEqual(detectPorts(explicit.repo).ports, { PORT: 4000 });
});

test("doctor reports what to fix", async (t) => {
  const empty = sandbox();
  t.after(empty.cleanup);
  const failing = await runCli(empty.repo, ["doctor"], empty.home);
  assert.equal(failing.code, 1);
  assert.match(failing.stdout, /FAIL {2}No nocollide\.json/);

  const box = sandbox({ "nocollide.json": config({ WEB_PORT: await freeBase() }), ".gitignore": ".env.local\n" });
  t.after(box.cleanup);
  installHook(box.repo);
  await runCli(box.repo, ["up"], box.home);
  const result = await runCli(box.repo, ["doctor"], box.home);
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /ok +nocollide\.json is valid/);
  assert.match(result.stdout, /ok +\.env\.local is ignored by git/);
  assert.match(result.stdout, /ok +post-checkout hook/);
  assert.match(result.stdout, /ok +This worktree has slot 0/);
});
