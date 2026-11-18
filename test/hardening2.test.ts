import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { down, gc, list, up } from "../src/core.js";
import { currentWorktree } from "../src/git.js";
import { pathKey } from "../src/paths.js";
import { setPsqlRunner } from "../src/postgres.js";
import { homeDir, withLock, withRegistry } from "../src/registry.js";
import { addWorktree, config, freeBase, removeWorktree, sandbox } from "./helpers.js";

test("a failed postgres create does not take ownership of a database created later", async (t) => {
  const databases = new Set(["app"]);
  const calls: string[] = [];
  setPsqlRunner(async (_url, sql) => {
    calls.push(sql);
    const exists = /datname = '(.+)'$/.exec(sql);
    if (exists?.[1]) return databases.has(exists[1]) ? "1" : "";
    if (sql.startsWith("CREATE DATABASE")) throw new Error("source database is being accessed by other users");
    const drop = /^DROP DATABASE IF EXISTS "(.+?)"/.exec(sql);
    if (drop?.[1]) databases.delete(drop[1]);
    return "";
  });
  t.after(() => setPsqlRunner(undefined));
  const box = sandbox({
    "slotenv.json": config({ WEB_PORT: await freeBase() }, { databases: { DATABASE_URL: { kind: "postgres", url: "postgres://localhost/app" } } }),
  });
  t.after(box.cleanup);
  const worktree = addWorktree(box, "crash");
  await assert.rejects(up(worktree), /something is connected/);
  assert.deepEqual((await list(worktree))[0]?.databases ?? [], []);
  databases.add("app_s1");
  calls.length = 0;
  const claim = await up(worktree);
  assert.match(claim.warnings.join(" "), /already existed/);
  await down(worktree);

  await up(worktree);
  const repo = pathKey(currentWorktree(worktree).repo);
  await withRegistry((registry) => {
    registry.repos[repo]![pathKey(worktree)]!.databases = [{ kind: "postgres", url: "postgres://localhost/app_s1", ready: false }];
  });
  await down(worktree);
  assert.ok(databases.has("app_s1"));
  assert.ok(calls.every((sql) => sql.startsWith("SELECT")));
});

test("down waits for up to finish provisioning and writing the env file", async (t) => {
  let checked!: () => void;
  let resume!: () => void;
  const checking = new Promise<void>((resolve) => { checked = resolve; });
  const paused = new Promise<void>((resolve) => { resume = resolve; });
  const databases = new Set<string>();
  setPsqlRunner(async (_url, sql) => {
    if (sql.startsWith("SELECT")) {
      checked();
      await paused;
    } else if (sql.startsWith("CREATE DATABASE")) databases.add("app_s1");
    else if (sql.startsWith("DROP DATABASE")) databases.delete("app_s1");
    return "";
  });
  t.after(() => setPsqlRunner(undefined));
  const box = sandbox({
    "slotenv.json": config({ WEB_PORT: await freeBase() }, { databases: { DATABASE_URL: { kind: "postgres", url: "postgres://localhost/app" } } }),
  });
  t.after(box.cleanup);
  const worktree = addWorktree(box, "overlap");
  const starting = up(worktree);
  await checking;
  const stopping = down(worktree);
  try {
    await Promise.race([stopping, sleep(150)]);
  } finally {
    resume();
  }
  const [claim, released] = await Promise.all([starting, stopping]);
  assert.deepEqual(released.droppedDatabases, claim.createdDatabases);
  assert.equal(databases.size, 0);
  assert.equal(existsSync(join(worktree, ".env.local")), false);
  assert.deepEqual(await list(worktree), []);
});

test("provisioning stops before creating a database when its claim is missing", async (t) => {
  const box = sandbox({
    "slotenv.json": config({ WEB_PORT: await freeBase() }, { databases: { DATABASE_URL: { kind: "postgres", url: "postgres://localhost/app" } } }),
  });
  t.after(box.cleanup);
  const worktree = addWorktree(box, "lost");
  let created = false;
  setPsqlRunner(async (_url, sql) => {
    if (sql.startsWith("SELECT")) await withRegistry((registry) => { registry.repos = {}; });
    else if (sql.startsWith("CREATE")) created = true;
    return "";
  });
  t.after(() => setPsqlRunner(undefined));
  await assert.rejects(up(worktree), /no longer claimed/);
  assert.equal(created, false);
  assert.equal(existsSync(join(worktree, ".env.local")), false);
});

test("removing a worktree and adding one with the same name starts a fresh slot", async (t) => {
  const box = sandbox({ "slotenv.json": config({ WEB_PORT: await freeBase() }) });
  t.after(box.cleanup);
  const first = addWorktree(box, "feat");
  await up(first);
  removeWorktree(box, first);
  const again = join(box.dir, "elsewhere");
  execFileSync("git", ["worktree", "add", "-q", again, "feat"], { cwd: box.repo, stdio: "ignore" });
  const claim = await up(again);
  assert.equal(claim.created, true);
  assert.equal(claim.slot, 2);
  const collected = await gc();
  assert.deepEqual(
    collected.removed.map((entry) => entry.slot),
    [1],
  );
});

test("slot numbers shared by two repos since 0.2 are split again", async (t) => {
  const base = await freeBase();
  const first = sandbox({ "slotenv.json": config({ WEB_PORT: base }) });
  const second = sandbox({ "slotenv.json": config({ WEB_PORT: base }) });
  t.after(first.cleanup);
  t.after(second.cleanup);
  process.env.SLOTENV_HOME = first.home;
  const a = addWorktree(first, "a");
  const b = addWorktree(second, "b");
  await up(a);
  await withRegistry((registry) => {
    const repo = pathKey(currentWorktree(b).repo);
    registry.repos[repo] = {
      [pathKey(b)]: { slot: 1, root: b, ports: { WEB_PORT: base + 10 }, claimedAt: new Date().toISOString() },
    };
  });
  assert.equal((await list(b))[0]?.slot, 1);
  const claim = await up(b);
  assert.equal(claim.slot, 2);
  assert.equal((await list(b)).length, 1);
  assert.equal((await up(a)).slot, 1);
});

test("a lock is only released by the holder that took it", async (t) => {
  const box = sandbox();
  t.after(box.cleanup);
  const lock = join(homeDir(), "probe.lock");
  await withLock("probe", 1000, "the probe lock", async () => {
    writeFileSync(join(lock, "owner"), `${process.pid} someone-else`);
  });
  assert.ok(existsSync(lock));
  assert.equal(readFileSync(join(lock, "owner"), "utf8"), `${process.pid} someone-else`);
});
