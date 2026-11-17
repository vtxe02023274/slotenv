import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gc, list, up } from "../src/core.js";
import { currentWorktree } from "../src/git.js";
import { pathKey } from "../src/paths.js";
import { setPsqlRunner } from "../src/postgres.js";
import { homeDir, withLock, withRegistry } from "../src/registry.js";
import { addWorktree, config, freeBase, removeWorktree, sandbox } from "./helpers.js";

test("an interrupted copy is made again instead of being reused", async (t) => {
  const databases = new Set(["app"]);
  const calls: string[] = [];
  let crash = true;
  setPsqlRunner(async (_url, sql) => {
    calls.push(sql);
    const exists = /datname = '(.+)'$/.exec(sql);
    if (exists?.[1]) return databases.has(exists[1]) ? "1" : "";
    const create = /^CREATE DATABASE "(.+?)"/.exec(sql);
    if (create?.[1]) {
      databases.add(create[1]);
      if (crash) throw new Error("killed during the copy");
      return "";
    }
    const drop = /^DROP DATABASE IF EXISTS "(.+?)"/.exec(sql);
    if (drop?.[1]) databases.delete(drop[1]);
    return "";
  });
  t.after(() => setPsqlRunner(undefined));
  const box = sandbox({
    "nocollide.json": config({ WEB_PORT: await freeBase() }, { databases: { DATABASE_URL: { kind: "postgres", url: "postgres://localhost/app" } } }),
  });
  t.after(box.cleanup);
  const worktree = addWorktree(box, "crash");
  await assert.rejects(up(worktree), /killed during the copy/);
  assert.deepEqual((await list(worktree))[0]?.databases, [{ kind: "postgres", url: "postgres://localhost/app_s1", ready: false }]);

  crash = false;
  calls.length = 0;
  const claim = await up(worktree);
  assert.match(claim.warnings.join(" "), /did not finish/);
  assert.doesNotMatch(claim.warnings.join(" "), /already existed/);
  assert.ok(calls.some((sql) => sql.startsWith('DROP DATABASE IF EXISTS "app_s1"')));
  assert.ok(calls.some((sql) => sql.startsWith('CREATE DATABASE "app_s1"')));
  assert.deepEqual((await list(worktree))[0]?.databases, [{ kind: "postgres", url: "postgres://localhost/app_s1", ready: true }]);
});

test("removing a worktree and adding one with the same name starts a fresh slot", async (t) => {
  const box = sandbox({ "nocollide.json": config({ WEB_PORT: await freeBase() }) });
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
  const first = sandbox({ "nocollide.json": config({ WEB_PORT: base }) });
  const second = sandbox({ "nocollide.json": config({ WEB_PORT: base }) });
  t.after(first.cleanup);
  t.after(second.cleanup);
  process.env.NOCOLLIDE_HOME = first.home;
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
