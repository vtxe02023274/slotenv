import { execFile, spawn } from "node:child_process";
import { SlotenvError } from "./errors.js";

export interface MysqlRunner {
  query(url: string, sql: string): Promise<string>;
  copy(from: string, to: string): Promise<void>;
}

interface Connection {
  args: string[];
  env: NodeJS.ProcessEnv;
}

function connection(url: string): Connection {
  const parsed = new URL(url);
  const args = ["--protocol=TCP", "-h", parsed.hostname || "127.0.0.1", "-P", parsed.port || "3306"];
  if (parsed.username) args.push("-u", decodeURIComponent(parsed.username));
  const env = { ...process.env };
  if (parsed.password) env.MYSQL_PWD = decodeURIComponent(parsed.password);
  return { args, env };
}

function missing(command: string): SlotenvError {
  return new SlotenvError(`${command} was not found. Install the MySQL client tools and make sure ${command} is on your PATH.`);
}

function query(url: string, sql: string): Promise<string> {
  const { args, env } = connection(url);
  return new Promise((resolve, reject) => {
    execFile("mysql", [...args, "-N", "-B", "-e", sql], { env, encoding: "utf8", windowsHide: true }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout.trim());
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return reject(missing("mysql"));
      reject(new SlotenvError(`mysql failed: ${(stderr || error.message).trim()}`));
    });
  });
}

function copy(from: string, to: string): Promise<void> {
  const source = connection(from);
  const target = connection(to);
  return new Promise((resolve, reject) => {
    const dump = spawn(
      "mysqldump",
      [...source.args, "--single-transaction", "--routines", "--triggers", "--events", databaseName(from)],
      { env: source.env, windowsHide: true },
    );
    const load = spawn("mysql", [...target.args, databaseName(to)], { env: target.env, windowsHide: true });
    let errors = "";
    let pending = 2;
    let failed = false;
    const fail = (error: SlotenvError) => {
      if (failed) return;
      failed = true;
      dump.kill();
      load.kill();
      reject(error);
    };
    dump.on("error", (error: NodeJS.ErrnoException) => fail(error.code === "ENOENT" ? missing("mysqldump") : new SlotenvError(error.message)));
    load.on("error", (error: NodeJS.ErrnoException) => fail(error.code === "ENOENT" ? missing("mysql") : new SlotenvError(error.message)));
    dump.stderr.on("data", (chunk) => (errors += chunk));
    load.stderr.on("data", (chunk) => (errors += chunk));
    load.stdin.on("error", () => undefined);
    dump.stdout.on("error", () => undefined);
    dump.stdout.pipe(load.stdin);
    const done = (name: string) => (code: number | null) => {
      if (code !== 0) return fail(new SlotenvError(`${name} failed: ${errors.trim() || `exit code ${code}`}`));
      pending -= 1;
      if (pending === 0 && !failed) resolve();
    };
    dump.on("close", done("mysqldump"));
    load.on("close", done("mysql"));
  });
}

let runner: MysqlRunner = { query, copy };

export function setMysqlRunner(next: MysqlRunner | undefined): void {
  runner = next ?? { query, copy };
}

export function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.slice(1));
}

export function quoteName(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

export async function mysqlDatabaseExists(url: string): Promise<boolean> {
  const sql = `SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ${quoteLiteral(databaseName(url))}`;
  return (await runner.query(url, sql)) === "1";
}

export async function createMysqlDatabase(url: string, template: string | undefined): Promise<void> {
  await runner.query(url, `CREATE DATABASE ${quoteName(databaseName(url))}`);
  if (!template) return;
  const source = new URL(url);
  source.pathname = `/${encodeURIComponent(template)}`;
  try {
    await runner.copy(source.toString(), url);
  } catch (error) {
    await runner.query(url, `DROP DATABASE IF EXISTS ${quoteName(databaseName(url))}`).catch(() => undefined);
    throw error;
  }
}

export async function dropMysqlDatabase(url: string): Promise<void> {
  await runner.query(url, `DROP DATABASE IF EXISTS ${quoteName(databaseName(url))}`);
}
