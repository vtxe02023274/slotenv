import { execFile } from "node:child_process";
import { SlotenvError } from "./errors.js";

export type PsqlRunner = (url: string, sql: string) => Promise<string>;

function defaultRunner(url: string, sql: string): Promise<string> {
  const parsed = new URL(url);
  const env = { ...process.env };
  let password = parsed.password ? decodeURIComponent(parsed.password) : undefined;
  parsed.password = "";
  const params = parsed.search.slice(1).split("&").filter((param) => {
    const equals = param.indexOf("=");
    if (equals < 0 || !new URLSearchParams(param).has("password")) return true;
    password = decodeURIComponent(param.slice(equals + 1));
    return false;
  });
  parsed.search = params.join("&");
  if (password !== undefined) env.PGPASSWORD = password;
  return new Promise((resolve, reject) => {
    execFile(
      "psql",
      [parsed.toString(), "-w", "-v", "ON_ERROR_STOP=1", "-X", "-q", "-t", "-A", "-c", sql],
      { encoding: "utf8", windowsHide: true, env },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout.trim());
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return reject(
            new SlotenvError("psql was not found. Install the Postgres client tools and make sure psql is on your PATH."),
          );
        }
        reject(new SlotenvError(`psql failed: ${(stderr || error.message).trim()}`));
      },
    );
  });
}

let runner: PsqlRunner = defaultRunner;

export function setPsqlRunner(next: PsqlRunner | undefined): void {
  runner = next ?? defaultRunner;
}

export function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.slice(1));
}

export function withDatabase(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${encodeURIComponent(name)}`;
  return parsed.toString();
}

export function adminUrl(url: string): string {
  return withDatabase(url, "postgres");
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export async function databaseExists(url: string): Promise<boolean> {
  const name = databaseName(url);
  const output = await runner(adminUrl(url), `SELECT 1 FROM pg_database WHERE datname = ${quoteLiteral(name)}`);
  return output === "1";
}

export async function createDatabase(url: string, template: string | undefined): Promise<void> {
  const name = databaseName(url);
  const sql = template ? `CREATE DATABASE ${quoteIdent(name)} TEMPLATE ${quoteIdent(template)}` : `CREATE DATABASE ${quoteIdent(name)}`;
  try {
    await runner(adminUrl(url), sql);
  } catch (error) {
    const message = (error as Error).message;
    if (template && /being accessed by other users/.test(message)) {
      throw new SlotenvError(
        `Could not copy "${template}" because something is connected to it. Stop the dev server of the main worktree, run "slotenv up" again, or set "template": false to start with an empty database.`,
      );
    }
    throw error;
  }
}

export async function dropDatabase(url: string): Promise<void> {
  const name = databaseName(url);
  try {
    await runner(adminUrl(url), `DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
  } catch (error) {
    if (!/syntax error/i.test((error as Error).message)) throw error;
    await runner(adminUrl(url), `DROP DATABASE IF EXISTS ${quoteIdent(name)}`);
  }
}
