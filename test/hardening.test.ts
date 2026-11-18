import assert from "node:assert/strict";
import childProcess, { ChildProcess, execFileSync } from "node:child_process";
import fs, { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { down, gc, list, up } from "../src/core.js";
import { HOOK_BLOCK, hookLocation, installHook } from "../src/hook.js";
import { setMysqlRunner } from "../src/mysql.js";
import { databaseExists, setPsqlRunner } from "../src/postgres.js";
import { redact } from "../src/redact.js";
import { homeDir, withRegistry } from "../src/registry.js";
import { addWorktree, config, freeBase, removeWorktree, runCli, sandbox } from "./helpers.js";

function memoryPostgres(existing: string[]) {
  const databases = new Set(existing);
  let failDrop: string | undefined;
  setPsqlRunner(async (_url, sql) => {
    const exists = /datname = '(.+)'$/.exec(sql);
    if (exists?.[1]) return databases.has(exists[1]) ? "1" : "";
    const create = /^CREATE DATABASE "(.+?)"/.exec(sql);
    if (create?.[1]) {
      databases.add(create[1]);
      return "";
    }
    const drop = /^DROP DATABASE IF EXISTS "(.+?)"/.exec(sql);
    if (drop?.[1]) {
      if (failDrop) throw new Error(failDrop);
      databases.delete(drop[1]);
      return "";
    }
    return "";
  });
  return {
    databases,
    failDrops(message: string | undefined) {
      failDrop = message;
    },
  };
}

test("worktrees of different repositories never share a slot", async (t) => {
  const base = await freeBase();
  const first = sandbox({ "slotenv.json": config({ WEB_PORT: base }) });
  const second = sandbox({ "slotenv.json": config({ WEB_PORT: base }) });
  t.after(first.cleanup);
  t.after(second.cleanup);
  process.env.SLOTENV_HOME = first.home;
  const a = await up(addWorktree(first, "a"));
  const b = await up(addWorktree(second, "b"));
  assert.equal(a.slot, 1);
  assert.equal(b.slot, 2);
});

test("a database that already existed is used but never dropped", async (t) => {
  const pg = memoryPostgres(["app", "app_s1"]);
  t.after(() => setPsqlRunner(undefined));
  const box = sandbox({
    "slotenv.json": config({ WEB_PORT: await freeBase() }, { databases: { DATABASE_URL: { kind: "postgres", url: "postgres://localhost/app" } } }),
  });
  t.after(box.cleanup);
  const worktree = addWorktree(box, "shared");
  const claim = await up(worktree);
  assert.match(claim.warnings[0] ?? "", /already existed/);
  assert.deepEqual(claim.createdDatabases, []);
  await down(worktree);
  assert.ok(pg.databases.has("app_s1"));
});

test("a database created before a later failure is still recorded and dropped", async (t) => {
  const pg = memoryPostgres(["app"]);
  t.after(() => setPsqlRunner(undefined));
  setMysqlRunner({
    async query() {
      throw new Error("mysql was not found");
    },
    async copy() {},
  });
  t.after(() => setMysqlRunner(undefined));
  const box = sandbox({
    "slotenv.json": config(
      { WEB_PORT: await freeBase() },
      {
        databases: {
          DATABASE_URL: { kind: "postgres", url: "postgres://localhost/app" },
          LEGACY_URL: { kind: "mysql", url: "mysql://root@localhost/legacy" },
        },
      },
    ),
  });
  t.after(box.cleanup);
  const worktree = addWorktree(box, "half");
  await assert.rejects(up(worktree), /mysql was not found/);
  assert.ok(pg.databases.has("app_s1"));
  const rows = await list(worktree);
  assert.deepEqual(rows[0]?.databases, [{ kind: "postgres", url: "postgres://localhost/app_s1", ready: true }]);
  await down(worktree);
  assert.equal(pg.databases.has("app_s1"), false);
});

test("a failed drop keeps the slot so down can be retried, and hides passwords", async (t) => {
  const pg = memoryPostgres(["app"]);
  t.after(() => setPsqlRunner(undefined));
  const box = sandbox({
    "slotenv.json": config(
      { WEB_PORT: await freeBase() },
      { databases: { DATABASE_URL: { kind: "postgres", url: "postgres://me:hunter2@localhost/app" } } },
    ),
  });
  t.after(box.cleanup);
  const worktree = addWorktree(box, "retry");
  await up(worktree);
  pg.failDrops("connection to postgres://me:hunter2@localhost/app_s1 failed");
  await assert.rejects(down(worktree), (error: Error) => {
    assert.match(error.message, /run "slotenv down" again/);
    assert.doesNotMatch(error.message, /hunter2/);
    return true;
  });
  assert.equal((await list(worktree)).length, 1);
  pg.failDrops(undefined);
  await down(worktree);
  assert.equal(pg.databases.has("app_s1"), false);
  assert.equal((await list(worktree)).length, 0);
});

test("a moved worktree keeps its slot and gc leaves it alone", async (t) => {
  const pg = memoryPostgres(["app"]);
  t.after(() => setPsqlRunner(undefined));
  const box = sandbox({
    "slotenv.json": config({ WEB_PORT: await freeBase() }, { databases: { DATABASE_URL: { kind: "postgres", url: "postgres://localhost/app" } } }),
  });
  t.after(box.cleanup);
  const before = addWorktree(box, "before");
  await up(before);
  const after = join(box.dir, "after");
  execFileSync("git", ["worktree", "move", before, after], { cwd: box.repo, stdio: "ignore" });
  const collected = await gc();
  assert.deepEqual(collected.removed, []);
  assert.ok(pg.databases.has("app_s1"));
  const claim = await up(after);
  assert.equal(claim.slot, 1);
  assert.equal(claim.created, false);
  const rows = await list(after);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.current, true);
});

test("a replacement at a moved worktree's path has its own slot and database", async (t) => {
  const pg = memoryPostgres(["app"]);
  t.after(() => setPsqlRunner(undefined));
  const box = sandbox({
    "slotenv.json": config({ WEB_PORT: await freeBase() }, { databases: { DATABASE_URL: { kind: "postgres", url: "postgres://localhost/app" } } }),
  });
  t.after(box.cleanup);
  const original = addWorktree(box, "original");
  await up(original);
  const moved = join(box.dir, "moved");
  execFileSync("git", ["worktree", "move", original, moved], { cwd: box.repo, stdio: "ignore" });
  execFileSync("git", ["worktree", "add", "--detach", original], { cwd: box.repo, stdio: "ignore" });

  assert.equal((await down(original)).slot, undefined);
  assert.ok(pg.databases.has("app_s1"));
  const replacement = await up(original);
  assert.equal(replacement.slot, 2);
  assert.deepEqual((await down(original)).droppedDatabases, ["postgres://localhost/app_s2"]);
  assert.ok(pg.databases.has("app_s1"));
  assert.match(readFileSync(join(moved, ".env.local"), "utf8"), /app_s1/);
  assert.equal((await up(moved)).slot, 1);
});

test("gc preserves claims for locked worktrees and unavailable repositories", async (t) => {
  const pg = memoryPostgres(["app"]);
  t.after(() => setPsqlRunner(undefined));
  const box = sandbox({
    "slotenv.json": config({ WEB_PORT: await freeBase() }, { databases: { DATABASE_URL: { kind: "postgres", url: "postgres://localhost/app" } } }),
  });
  t.after(box.cleanup);
  const locked = addWorktree(box, "locked");
  const unavailable = addWorktree(box, "unavailable");
  await up(locked);
  await up(unavailable);
  execFileSync("git", ["worktree", "lock", "--reason", "removable", locked], { cwd: box.repo });
  renameSync(locked, `${locked}-offline`);
  assert.deepEqual((await gc()).removed, []);
  assert.ok(pg.databases.has("app_s1"));

  renameSync(unavailable, `${unavailable}-offline`);
  renameSync(box.repo, `${box.repo}-offline`);
  assert.deepEqual((await gc()).removed, []);
  assert.ok(pg.databases.has("app_s2"));

  renameSync(box.repo + "-offline", box.repo);
  renameSync(`${locked}-offline`, locked);
  execFileSync("git", ["worktree", "unlock", locked], { cwd: box.repo });
  removeWorktree(box, locked);
  assert.deepEqual((await gc()).droppedDatabases, ["postgres://localhost/app_s1", "postgres://localhost/app_s2"]);
});

test("Husky v9 hooks go into .husky/post-checkout", (t) => {
  const box = sandbox();
  t.after(box.cleanup);
  mkdirSync(join(box.repo, ".husky", "_"), { recursive: true });
  execFileSync("git", ["config", "core.hooksPath", ".husky/_"], { cwd: box.repo });
  const location = hookLocation(box.repo);
  assert.equal(location.husky, true);
  assert.equal(location.file, join(box.repo, ".husky", "post-checkout"));
  installHook(box.repo);
  assert.equal(readFileSync(location.file, "utf8"), `${HOOK_BLOCK}\n`);
});

test("the hook block fires for null object names of any length", () => {
  assert.match(HOOK_BLOCK, /case "\$1" in\n {2}\*\[!0\]\*\) ;;/);
});

test("run, env and port leave a hand-written .env.local alone", async (t) => {
  const base = await freeBase();
  const box = sandbox({ "slotenv.json": config({ WEB_PORT: base }), "args.js": "console.log(process.argv.slice(2).join(' '))\n" });
  t.after(box.cleanup);
  const worktree = addWorktree(box, "manual");
  writeFileSync(join(worktree, ".env.local"), "MINE=1\n");
  const run = await runCli(worktree, ["run", "node", "args.js", "--", "x"], box.home);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout.trim(), "-- x");
  const env = await runCli(worktree, ["env", "--json"], box.home);
  assert.equal(JSON.parse(env.stdout).WEB_PORT, String(base + 10));
  const port = await runCli(worktree, ["port", "WEB_PORT"], box.home);
  assert.equal(port.stdout.trim(), String(base + 10));
  assert.equal(readFileSync(join(worktree, ".env.local"), "utf8"), "MINE=1\n");
});

test("a lock left by a dead process is taken over at once", async (t) => {
  const box = sandbox();
  t.after(box.cleanup);
  const lock = join(homeDir(), "registry.lock");
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "owner"), "2147483646 deadbeef");
  const started = Date.now();
  await withRegistry(() => undefined);
  assert.ok(Date.now() - started < 2000);
  assert.equal(existsSync(lock), false);
});

test("the registry directory and temporary file request private permissions", async (t) => {
  const box = sandbox();
  t.after(box.cleanup);
  const mkdir = t.mock.method(fs, "mkdirSync");
  const write = t.mock.method(fs, "writeFileSync");
  syncBuiltinESMExports();
  try {
    const file = join(box.home, "slots.json");
    await withRegistry(() => undefined);
    const dir = mkdir.mock.calls.find(({ arguments: [path] }) => path === box.home);
    const temp = write.mock.calls.find(({ arguments: [path] }) => String(path).startsWith(`${file}.`));
    assert.equal((dir?.arguments[1] as fs.MakeDirectoryOptions | undefined)?.mode, 0o700);
    assert.equal((temp?.arguments[2] as fs.WriteFileOptions & { mode?: number } | undefined)?.mode, 0o600);
    if (process.platform !== "win32") {
      assert.equal(statSync(box.home).mode & 0o077, 0);
      assert.equal(statSync(file).mode & 0o077, 0);
    }
  } finally {
    mkdir.mock.restore();
    write.mock.restore();
    syncBuiltinESMExports();
  }
});

test("a sqlite snapshot includes committed WAL rows even when the WAL is checkpointed", async (t) => {
  const box = sandbox({
    "slotenv.json": config({ WEB_PORT: await freeBase() }, { databases: { DATABASE_URL: { kind: "sqlite", path: "db/dev.sqlite3" } } }),
    ".gitignore": "db/\n",
  });
  t.after(box.cleanup);
  mkdirSync(join(box.repo, "db"));
  const worktree = addWorktree(box, "wal");
  const source = join(box.repo, "db", "dev.sqlite3");
  const target = join(worktree, "db", "dev.sqlite3");
  const db = new DatabaseSync(source);
  const copyFile = fs.copyFileSync;
  const copy = t.mock.method(fs, "copyFileSync", (from: fs.PathLike, to: fs.PathLike, mode?: number) => {
    copyFile(from, to, mode);
    if (from === source) db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  });
  syncBuiltinESMExports();
  try {
    db.exec("CREATE TABLE items (id INTEGER); PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; INSERT INTO items VALUES (42)");
    assert.ok(statSync(`${source}-wal`).size > 0);
    await up(worktree);
    const snapshot = new DatabaseSync(target);
    try {
      assert.equal(snapshot.prepare("SELECT id FROM items").get()?.id, 42);
    } finally {
      snapshot.close();
    }
  } finally {
    copy.mock.restore();
    syncBuiltinESMExports();
    db.close();
  }
});

test("redact hides passwords anywhere in a message", () => {
  assert.equal(
    redact("failed for postgres://me:pw@h/db and redis://:secret@h:6379/1"),
    "failed for postgres://me:***@h/db and redis://:***@h:6379/1",
  );
  assert.equal(
    redact('failed for "postgresql://localhost/app?user=dev&password=one&%70assword=two&sslmode=require"'),
    'failed for "postgresql://localhost/app?user=dev&password=***&%70assword=***&sslmode=require"',
  );
  assert.equal(redact("postgresql://localhost/app?password=one'two"), "postgresql://localhost/app?password=***");
});

test("psql gets the effective password through its environment", async (t) => {
  const execute = t.mock.method(childProcess, "execFile", (...args: unknown[]) => {
    (args[3] as (error: null, stdout: string, stderr: string) => void)(null, "1", "");
    return new ChildProcess();
  });
  syncBuiltinESMExports();
  try {
    assert.equal(await databaseExists("postgresql://dev:old@localhost/app?password=first&%70assword=a+b%26c&application_name=a%20b"), true);
    assert.equal(await databaseExists("postgresql://dev:h%40st@localhost/app"), true);
    const [query, userInfo] = execute.mock.calls;
    assert.equal((query?.arguments[1] as string[])[0], "postgresql://dev@localhost/postgres?application_name=a%20b");
    assert.equal((query?.arguments[2] as { env: NodeJS.ProcessEnv }).env.PGPASSWORD, "a+b&c");
    assert.equal((userInfo?.arguments[1] as string[])[0], "postgresql://dev@localhost/postgres");
    assert.equal((userInfo?.arguments[2] as { env: NodeJS.ProcessEnv }).env.PGPASSWORD, "h@st");
  } finally {
    execute.mock.restore();
    syncBuiltinESMExports();
  }
});
