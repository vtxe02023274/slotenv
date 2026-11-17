import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseConfig } from "../src/config.js";
import { down, gc, init, up } from "../src/core.js";
import { composeProjectName, slotDatabaseValue } from "../src/databases.js";
import { detectPorts } from "../src/detect.js";
import { setMysqlRunner } from "../src/mysql.js";
import { setPsqlRunner } from "../src/postgres.js";
import { addWorktree, freeBase, removeWorktree, sandbox } from "./helpers.js";

function fakePostgres(existing: string[] = ["app_dev"]) {
  const databases = new Set(existing);
  const calls: string[] = [];
  setPsqlRunner(async (url, sql) => {
    calls.push(sql);
    assert.equal(new URL(url).pathname, "/postgres");
    const exists = /datname = '(.+)'$/.exec(sql);
    if (exists?.[1]) return databases.has(exists[1].replace(/''/g, "'")) ? "1" : "";
    const create = /^CREATE DATABASE "(.+?)"(?: TEMPLATE "(.+)")?$/.exec(sql);
    if (create?.[1]) {
      if (create[2] && !databases.has(create[2])) throw new Error(`psql failed: template "${create[2]}" does not exist`);
      databases.add(create[1]);
      return "";
    }
    const drop = /^DROP DATABASE IF EXISTS "(.+?)"/.exec(sql);
    if (drop?.[1]) {
      databases.delete(drop[1]);
      return "";
    }
    throw new Error(`unexpected sql: ${sql}`);
  });
  return { databases, calls };
}

async function dbConfig(extra: Record<string, unknown>): Promise<string> {
  return `${JSON.stringify({ ports: { WEB_PORT: await freeBase() }, env: { to: ".env.local" }, ...extra }, null, 2)}\n`;
}

test("slot values for postgres, redis and sqlite", () => {
  const pg = { kind: "postgres", url: "postgres://me:secret@localhost:5432/app_dev?sslmode=disable", template: true } as const;
  assert.equal(slotDatabaseValue(pg, 0), pg.url);
  assert.equal(slotDatabaseValue(pg, 2), "postgres://me:secret@localhost:5432/app_dev_s2?sslmode=disable");
  assert.equal(slotDatabaseValue({ kind: "redis", url: "redis://localhost:6379/3" }, 2), "redis://localhost:6379/5");
  assert.equal(slotDatabaseValue({ kind: "redis", url: "redis://localhost:6379" }, 1), "redis://localhost:6379/1");
  assert.equal(slotDatabaseValue({ kind: "sqlite", path: "data/dev.db" }, 4), "data/dev.db");
});

test("compose project names are valid and unique per slot", () => {
  assert.equal(composeProjectName({}, "/home/me/My App", 0), "my-app");
  assert.equal(composeProjectName({}, "/home/me/My App", 3), "my-app-s3");
  assert.equal(composeProjectName({ name: "shop" }, "/x", 1), "shop-s1");
});

test("parseConfig validates databases and compose", () => {
  const config = parseConfig({
    databases: { DATABASE_URL: { kind: "postgres", url: "postgres://localhost/app" } },
    compose: true,
  });
  assert.deepEqual(config.ports, {});
  assert.deepEqual(config.databases, { DATABASE_URL: { kind: "postgres", url: "postgres://localhost/app", template: true } });
  assert.deepEqual(config.compose, {});
  assert.throws(() => parseConfig({ databases: { DATABASE_URL: { kind: "mongo" } } }), /"kind"/);
  assert.throws(() => parseConfig({ databases: { DATABASE_URL: { kind: "postgres", url: "postgres://localhost/" } } }), /name a database/);
  assert.throws(() => parseConfig({ databases: { REDIS_URL: { kind: "redis", url: "redis://localhost/x" } } }), /DB index/);
  assert.throws(() => parseConfig({ ports: { A_PORT: 3000 }, databases: { A_PORT: { kind: "sqlite", path: "a.db" } } }), /both/);
  assert.throws(() => parseConfig({ compose: "yes", ports: { A_PORT: 1 } }), /"compose"/);
});

test("init detects databases, Compose and leaves service ports alone", (t) => {
  const box = sandbox({
    ".env.example": [
      "PORT=3000",
      "DB_PORT=5432",
      "REDIS_PORT=6379",
      "DATABASE_URL=postgres://postgres:postgres@localhost:5432/shop",
      "REDIS_URL=redis://localhost:6379/0",
      "SQLITE_PATH=file:./data/dev.db",
      "SLOT_DB=postgres://localhost/app_s${SLOTENV_SLOT}",
      "API_URL=https://example.com",
      "",
    ].join("\n"),
  });
  t.after(box.cleanup);
  const detection = detectPorts(box.repo);
  assert.deepEqual(detection.ports, { PORT: 3000 });
  assert.deepEqual(detection.skipped, ["DB_PORT", "REDIS_PORT"]);
  assert.deepEqual(Object.keys(detection.databases), ["DATABASE_URL", "REDIS_URL", "SQLITE_PATH"]);
  assert.equal(detection.compose, false);

  writeFileSync(join(box.repo, "compose.yaml"), "services: {}\n");
  const withCompose = init(box.repo);
  assert.deepEqual(withCompose.config.ports, { PORT: 3000, DB_PORT: 5432, REDIS_PORT: 6379 });
  const written = JSON.parse(readFileSync(withCompose.file, "utf8"));
  assert.equal(written.compose, true);
  assert.equal(written.databases.DATABASE_URL.kind, "postgres");
});

test("postgres: each slot gets a database cloned from the template and down drops it", async (t) => {
  const pg = fakePostgres();
  t.after(() => setPsqlRunner(undefined));
  const box = sandbox({
    "slotenv.json": await dbConfig({ databases: { DATABASE_URL: { kind: "postgres", url: "postgres://me:pw@localhost:5432/app_dev" } } }),
  });
  t.after(box.cleanup);
  const main = await up(box.repo);
  assert.equal(main.vars.DATABASE_URL, "postgres://me:pw@localhost:5432/app_dev");
  assert.deepEqual(main.createdDatabases, []);

  const worktree = addWorktree(box, "feat");
  const claim = await up(worktree);
  assert.equal(claim.vars.DATABASE_URL, "postgres://me:pw@localhost:5432/app_dev_s1");
  assert.ok(pg.databases.has("app_dev_s1"));
  assert.ok(pg.calls.includes('CREATE DATABASE "app_dev_s1" TEMPLATE "app_dev"'));
  assert.match(readFileSync(join(worktree, ".env.local"), "utf8"), /^DATABASE_URL=postgres:\/\/me:pw@localhost:5432\/app_dev_s1$/m);

  const again = await up(worktree);
  assert.deepEqual(again.createdDatabases, []);

  const released = await down(worktree);
  assert.deepEqual(released.droppedDatabases, ["postgres://me:pw@localhost:5432/app_dev_s1"]);
  assert.equal(pg.databases.has("app_dev_s1"), false);
  assert.ok(pg.databases.has("app_dev"));
});

test("postgres: template false, --keep-data and gc", async (t) => {
  const pg = fakePostgres([]);
  t.after(() => setPsqlRunner(undefined));
  const box = sandbox({
    "slotenv.json": await dbConfig({
      databases: { DATABASE_URL: { kind: "postgres", url: "postgres://localhost/app", template: false } },
    }),
  });
  t.after(box.cleanup);
  const a = addWorktree(box, "a");
  const b = addWorktree(box, "b");
  await up(a);
  await up(b);
  assert.ok(pg.calls.includes('CREATE DATABASE "app_s1"'));
  const kept = await down(a, { keepData: true });
  assert.deepEqual(kept.keptDatabases, ["postgres://localhost/app_s1"]);
  assert.ok(pg.databases.has("app_s1"));

  removeWorktree(box, b);
  const collected = await gc();
  assert.deepEqual(collected.droppedDatabases, ["postgres://localhost/app_s2"]);
  assert.equal(pg.databases.has("app_s2"), false);
});

test("sqlite: the main worktree file is copied into new worktrees", async (t) => {
  const box = sandbox({
    "slotenv.json": await dbConfig({ databases: { DATABASE_URL: { kind: "sqlite", path: "file:./data/dev.db" } } }),
    ".gitignore": "data/\n.env.local\n",
  });
  t.after(box.cleanup);
  mkdirSync(join(box.repo, "data"));
  writeFileSync(join(box.repo, "data", "dev.db"), "seed");
  const worktree = addWorktree(box, "lite");
  const claim = await up(worktree);
  assert.deepEqual(claim.copied, [join(worktree, "data", "dev.db")]);
  assert.equal(readFileSync(join(worktree, "data", "dev.db"), "utf8"), "seed");
  writeFileSync(join(worktree, "data", "dev.db"), "changed");
  assert.deepEqual((await up(worktree)).copied, []);
  assert.equal(readFileSync(join(box.repo, "data", "dev.db"), "utf8"), "seed");
  await down(worktree);
  assert.ok(existsSync(join(worktree, "data", "dev.db")));
});

test("redis and compose variables reach the env file", async (t) => {
  const box = sandbox({
    "slotenv.json": await dbConfig({ databases: { REDIS_URL: { kind: "redis", url: "redis://localhost:6379/14" } }, compose: true }),
  });
  t.after(box.cleanup);
  const a = addWorktree(box, "a");
  const b = addWorktree(box, "b");
  const first = await up(a);
  assert.equal(first.vars.REDIS_URL, "redis://localhost:6379/15");
  assert.deepEqual(first.warnings, []);
  const second = await up(b);
  assert.equal(second.vars.REDIS_URL, "redis://localhost:6379/16");
  assert.match(second.warnings[0] ?? "", /Redis DB 16/);
  const env = readFileSync(join(b, ".env.local"), "utf8");
  assert.match(env, /^COMPOSE_PROJECT_NAME=repo-s2$/m);
  assert.match(env, /^REDIS_URL=redis:\/\/localhost:6379\/16$/m);
});

const realPostgres = process.env.SLOTENV_TEST_PG_URL;

test("postgres against a real server", { skip: realPostgres ? false : "set SLOTENV_TEST_PG_URL to run" }, async (t) => {
  const base = realPostgres!;
  const admin = new URL(base);
  admin.pathname = "/postgres";
  const { execFileSync } = await import("node:child_process");
  const psql = (url: string, sql: string) =>
    execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-X", "-q", "-t", "-A", "-c", sql], { encoding: "utf8" }).trim();
  const name = new URL(base).pathname.slice(1);
  psql(admin.toString(), `DROP DATABASE IF EXISTS "${name}_s1"`);
  psql(admin.toString(), `DROP DATABASE IF EXISTS "${name}"`);
  psql(admin.toString(), `CREATE DATABASE "${name}"`);
  psql(base, "CREATE TABLE items (id int); INSERT INTO items VALUES (1), (2)");

  const box = sandbox({ "slotenv.json": await dbConfig({ databases: { DATABASE_URL: { kind: "postgres", url: base } } }) });
  t.after(box.cleanup);
  const worktree = addWorktree(box, "pg");
  const claim = await up(worktree);
  const slotUrl = claim.vars.DATABASE_URL!;
  assert.equal(psql(slotUrl, "SELECT count(*) FROM items"), "2");
  psql(slotUrl, "INSERT INTO items VALUES (3)");
  assert.equal(psql(base, "SELECT count(*) FROM items"), "2");
  await down(worktree);
  assert.equal(psql(admin.toString(), `SELECT count(*) FROM pg_database WHERE datname = '${name}_s1'`), "0");
});

test("mysql: each slot gets a copy of the main database and down drops it", async (t) => {
  const databases = new Set(["shop"]);
  const copies: string[] = [];
  setMysqlRunner({
    async query(_url, sql) {
      const exists = /SCHEMA_NAME = '(.+)'$/.exec(sql);
      if (exists?.[1]) return databases.has(exists[1]) ? "1" : "";
      const create = /^CREATE DATABASE `(.+)`$/.exec(sql);
      if (create?.[1]) {
        databases.add(create[1]);
        return "";
      }
      const drop = /^DROP DATABASE IF EXISTS `(.+)`$/.exec(sql);
      if (drop?.[1]) {
        databases.delete(drop[1]);
        return "";
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
    async copy(from, to) {
      copies.push(`${new URL(from).pathname} -> ${new URL(to).pathname}`);
    },
  });
  t.after(() => setMysqlRunner(undefined));
  const box = sandbox({
    "slotenv.json": await dbConfig({ databases: { DATABASE_URL: { kind: "mysql", url: "mysql://root:pw@127.0.0.1:3306/shop" } } }),
  });
  t.after(box.cleanup);
  const worktree = addWorktree(box, "my");
  const claim = await up(worktree);
  assert.equal(claim.vars.DATABASE_URL, "mysql://root:pw@127.0.0.1:3306/shop_s1");
  assert.deepEqual(copies, ["/shop -> /shop_s1"]);
  assert.ok(databases.has("shop_s1"));
  assert.deepEqual((await up(worktree)).createdDatabases, []);
  await down(worktree);
  assert.equal(databases.has("shop_s1"), false);
  assert.ok(databases.has("shop"));
});

test("mysql: a failed copy removes the half-made database", async (t) => {
  const databases = new Set<string>();
  setMysqlRunner({
    async query(_url, sql) {
      if (sql.startsWith("SELECT")) return "";
      const name = /`(.+)`/.exec(sql)?.[1] ?? "";
      if (sql.startsWith("CREATE")) databases.add(name);
      if (sql.startsWith("DROP")) databases.delete(name);
      return "";
    },
    async copy() {
      throw new Error("mysqldump failed: Unknown database 'shop'");
    },
  });
  t.after(() => setMysqlRunner(undefined));
  const box = sandbox({
    "slotenv.json": await dbConfig({ databases: { DATABASE_URL: { kind: "mysql", url: "mysql://root@localhost/shop" } } }),
  });
  t.after(box.cleanup);
  await assert.rejects(up(addWorktree(box, "broken")), /Unknown database/);
  assert.equal(databases.size, 0);
});

const realMysql = process.env.SLOTENV_TEST_MYSQL_URL;

test("mysql against a real server", { skip: realMysql ? false : "set SLOTENV_TEST_MYSQL_URL to run" }, async (t) => {
  const base = realMysql!;
  const { execFileSync } = await import("node:child_process");
  const parsed = new URL(base);
  const name = parsed.pathname.slice(1);
  const sql = (statement: string, database = "") =>
    execFileSync(
      "mysql",
      ["--protocol=TCP", "-h", parsed.hostname, "-P", parsed.port || "3306", "-u", parsed.username, "-N", "-B", ...(database ? [database] : []), "-e", statement],
      { encoding: "utf8", env: { ...process.env, MYSQL_PWD: decodeURIComponent(parsed.password) } },
    ).trim();
  sql(`DROP DATABASE IF EXISTS \`${name}_s1\``);
  sql(`DROP DATABASE IF EXISTS \`${name}\``);
  sql(`CREATE DATABASE \`${name}\``);
  sql("CREATE TABLE items (id int); INSERT INTO items VALUES (1), (2);", name);

  const box = sandbox({ "slotenv.json": await dbConfig({ databases: { DATABASE_URL: { kind: "mysql", url: base } } }) });
  t.after(box.cleanup);
  const worktree = addWorktree(box, "mysql");
  await up(worktree);
  assert.equal(sql("SELECT count(*) FROM items", `${name}_s1`), "2");
  sql("INSERT INTO items VALUES (3)", `${name}_s1`);
  assert.equal(sql("SELECT count(*) FROM items", name), "2");
  await down(worktree);
  assert.equal(sql(`SELECT count(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = '${name}_s1'`), "0");
});

test("init detects MySQL and MariaDB URLs", (t) => {
  const box = sandbox({
    ".env.example": "DATABASE_URL=mysql://root:root@localhost:3306/shop\nLEGACY_DB=mariadb://localhost/legacy\n",
  });
  t.after(box.cleanup);
  assert.deepEqual(detectPorts(box.repo).databases, {
    DATABASE_URL: { kind: "mysql", url: "mysql://root:root@localhost:3306/shop", template: true },
    LEGACY_DB: { kind: "mysql", url: "mariadb://localhost/legacy", template: true },
  });
});
