import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { ComposeConfig, DatabaseConfig } from "./config.js";
import { createMysqlDatabase, mysqlDatabaseExists } from "./mysql.js";
import { createDatabase, databaseExists, databaseName, withDatabase } from "./postgres.js";

export const REDIS_DEFAULT_DATABASES = 16;

export interface CreatedDatabase {
  kind: "postgres" | "mysql";
  url: string;
}

export interface Provisioned {
  created: CreatedDatabase[];
  copied: string[];
  warnings: string[];
}

export function slotDatabaseValue(db: DatabaseConfig, slot: number): string {
  if (db.kind === "sqlite") return db.path;
  if (slot === 0) return db.url;
  if (db.kind === "postgres" || db.kind === "mysql") return withDatabase(db.url, `${databaseName(db.url)}_s${slot}`);
  const url = new URL(db.url);
  const base = Number(url.pathname.slice(1) || "0");
  url.pathname = `/${base + slot}`;
  return url.toString();
}

export function slotDatabaseVars(databases: Record<string, DatabaseConfig> | undefined, slot: number): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [name, db] of Object.entries(databases ?? {})) vars[name] = slotDatabaseValue(db, slot);
  return vars;
}

export function composeProjectName(compose: ComposeConfig, mainRoot: string, slot: number): string {
  const base =
    (compose.name ?? basename(mainRoot))
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^[^a-z0-9]+/, "") || "app";
  return slot === 0 ? base : `${base}-s${slot}`;
}

function sqliteFile(path: string): string {
  return path.replace(/^file:(\/\/)?/, "").replace(/\?.*$/, "");
}

export async function provisionDatabases(
  databases: Record<string, DatabaseConfig> | undefined,
  slot: number,
  root: string,
  mainRoot: string | undefined,
): Promise<Provisioned> {
  const result: Provisioned = { created: [], copied: [], warnings: [] };
  if (slot === 0 || !databases) return result;
  for (const [name, db] of Object.entries(databases)) {
    if (db.kind === "postgres") {
      const url = slotDatabaseValue(db, slot);
      if (!(await databaseExists(url))) {
        await createDatabase(url, db.template ? databaseName(db.url) : undefined);
        result.created.push({ kind: "postgres", url });
      }
    } else if (db.kind === "mysql") {
      const url = slotDatabaseValue(db, slot);
      if (!(await mysqlDatabaseExists(url))) {
        await createMysqlDatabase(url, db.template ? databaseName(db.url) : undefined);
        result.created.push({ kind: "mysql", url });
      }
    } else if (db.kind === "sqlite") {
      const file = sqliteFile(db.path);
      if (isAbsolute(file)) {
        result.warnings.push(`${name} points to an absolute path, so every worktree shares ${file}. Use a path inside the repository.`);
        continue;
      }
      const target = join(root, file);
      const source = mainRoot ? join(mainRoot, file) : undefined;
      if (!existsSync(target) && source && existsSync(source)) {
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(source, target);
        result.copied.push(target);
      }
    } else {
      const index = Number(new URL(slotDatabaseValue(db, slot)).pathname.slice(1));
      if (index >= REDIS_DEFAULT_DATABASES) {
        result.warnings.push(
          `${name} uses Redis DB ${index}. A default Redis server has ${REDIS_DEFAULT_DATABASES} (0-${REDIS_DEFAULT_DATABASES - 1}); raise "databases" in redis.conf.`,
        );
      }
    }
  }
  return result;
}
