import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NocollideError } from "./errors.js";

export interface EnvConfig {
  from?: string;
  to: string;
}

export interface PostgresConfig {
  kind: "postgres";
  url: string;
  template: boolean;
}

export interface MysqlConfig {
  kind: "mysql";
  url: string;
  template: boolean;
}

export interface SqliteConfig {
  kind: "sqlite";
  path: string;
}

export interface RedisConfig {
  kind: "redis";
  url: string;
}

export type DatabaseConfig = PostgresConfig | MysqlConfig | SqliteConfig | RedisConfig;

export interface ComposeConfig {
  name?: string;
}

export interface Config {
  ports: Record<string, number>;
  step: number;
  env?: EnvConfig;
  databases?: Record<string, DatabaseConfig>;
  compose?: ComposeConfig;
}

export const CONFIG_FILE = "nocollide.json";
export const DEFAULT_STEP = 10;

const VARIABLE = /^[A-Z_][A-Z0-9_]*$/;
const KINDS = ["postgres", "mysql", "sqlite", "redis"];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(reason: string): NocollideError {
  return new NocollideError(`Invalid ${CONFIG_FILE}: ${reason}.`);
}

function isUrl(value: unknown, schemes: string[]): value is string {
  if (typeof value !== "string") return false;
  try {
    return schemes.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function parseDatabase(name: string, value: unknown): DatabaseConfig {
  if (!isObject(value) || typeof value.kind !== "string" || !KINDS.includes(value.kind)) {
    throw invalid(`database "${name}" needs a "kind" of ${KINDS.join(", ")}`);
  }
  if (value.kind === "postgres") {
    if (!isUrl(value.url, ["postgres:", "postgresql:"])) {
      throw invalid(`database "${name}" needs a "url" such as postgres://localhost:5432/app_dev`);
    }
    const database = decodeURIComponent(new URL(value.url).pathname.slice(1));
    if (!database) throw invalid(`database "${name}" url must name a database, such as /app_dev`);
    if (value.template !== undefined && typeof value.template !== "boolean") {
      throw invalid(`database "${name}" "template" must be true or false`);
    }
    return { kind: "postgres", url: value.url, template: value.template !== false };
  }
  if (value.kind === "mysql") {
    if (!isUrl(value.url, ["mysql:", "mariadb:"])) {
      throw invalid(`database "${name}" needs a "url" such as mysql://root@localhost:3306/app_dev`);
    }
    if (!decodeURIComponent(new URL(value.url).pathname.slice(1))) {
      throw invalid(`database "${name}" url must name a database, such as /app_dev`);
    }
    if (value.template !== undefined && typeof value.template !== "boolean") {
      throw invalid(`database "${name}" "template" must be true or false`);
    }
    return { kind: "mysql", url: value.url, template: value.template !== false };
  }
  if (value.kind === "redis") {
    if (!isUrl(value.url, ["redis:", "rediss:"])) {
      throw invalid(`database "${name}" needs a "url" such as redis://localhost:6379/0`);
    }
    const index = new URL(value.url).pathname.slice(1);
    if (index !== "" && !/^\d+$/.test(index)) throw invalid(`database "${name}" url must end with a DB index such as /0`);
    return { kind: "redis", url: value.url };
  }
  if (typeof value.path !== "string" || value.path === "") {
    throw invalid(`database "${name}" needs a "path" such as data/dev.db`);
  }
  return { kind: "sqlite", path: value.path };
}

export function parseConfig(raw: unknown): Config {
  if (!isObject(raw)) throw invalid("the file must contain a JSON object");
  const { ports = {}, step = DEFAULT_STEP, env, databases, compose } = raw;
  if (!isObject(ports)) throw invalid('"ports" must map names to ports, for example { "WEB_PORT": 3000 }');
  const parsed: Record<string, number> = {};
  for (const [name, value] of Object.entries(ports)) {
    if (!VARIABLE.test(name)) {
      throw invalid(`port name "${name}" must be an upper-case variable name such as WEB_PORT`);
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
      throw invalid(`port "${name}" must be an integer between 1 and 65535`);
    }
    parsed[name] = value;
  }
  if (typeof step !== "number" || !Number.isInteger(step) || step < 1) {
    throw invalid('"step" must be a positive integer');
  }
  const config: Config = { ports: parsed, step };
  if (env !== undefined) {
    if (
      !isObject(env) ||
      typeof env.to !== "string" ||
      env.to === "" ||
      (env.from !== undefined && typeof env.from !== "string")
    ) {
      throw invalid('"env" must look like { "from": ".env.example", "to": ".env.local" }');
    }
    config.env = env.from ? { from: env.from, to: env.to } : { to: env.to };
  }
  if (databases !== undefined) {
    if (!isObject(databases)) throw invalid('"databases" must map variable names to databases');
    const parsedDatabases: Record<string, DatabaseConfig> = {};
    for (const [name, value] of Object.entries(databases)) {
      if (!VARIABLE.test(name)) {
        throw invalid(`database name "${name}" must be an upper-case variable name such as DATABASE_URL`);
      }
      if (name in parsed) throw invalid(`"${name}" is used both as a port and as a database`);
      parsedDatabases[name] = parseDatabase(name, value);
    }
    config.databases = parsedDatabases;
  }
  if (compose !== undefined && compose !== false) {
    if (compose === true) {
      config.compose = {};
    } else if (isObject(compose) && (compose.name === undefined || typeof compose.name === "string")) {
      config.compose = compose.name ? { name: compose.name } : {};
    } else {
      throw invalid('"compose" must be true, false or { "name": "myapp" }');
    }
  }
  if (Object.keys(parsed).length === 0 && !config.databases && !config.compose) {
    throw invalid('add at least one entry to "ports", for example { "WEB_PORT": 3000 }, or to "databases"');
  }
  return config;
}

export function loadConfig(root: string): Config {
  const file = join(root, CONFIG_FILE);
  if (!existsSync(file)) {
    throw new NocollideError(`No ${CONFIG_FILE} in ${root}. Run "nocollide init" first.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw invalid(`not valid JSON (${(error as Error).message})`);
  }
  return parseConfig(raw);
}
