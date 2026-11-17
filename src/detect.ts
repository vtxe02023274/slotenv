import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseConfig } from "./config.js";

export const ENV_TEMPLATES = [".env.example", ".env.sample", ".env.template"];
export const DEFAULT_PORTS: Record<string, number> = { PORT: 3000 };

export const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];

export interface Detection {
  ports: Record<string, number>;
  databases: Record<string, DatabaseConfig>;
  compose: boolean;
  envFrom?: string;
  hardcoded: string[];
  skipped: string[];
  detected: boolean;
}

export const SERVICE_PORTS = new Set([5432, 3306, 6379, 27017, 5672, 9200, 9092, 11211, 1025, 25, 587]);
const SERVICE_NAME = /^(DB|DATABASE|PG|POSTGRES|POSTGRESQL|MYSQL|MARIADB|REDIS|MONGO|MONGODB|SMTP|MAIL|RABBITMQ|AMQP|ELASTIC|ELASTICSEARCH|KAFKA|MEMCACHED)_/;

const ENV_VALUE = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*["']?([^"'\s#]*)["']?/;
const SQLITE_VALUE = /^file:|\.(db|sqlite3?)$/i;

function detectDatabase(value: string): DatabaseConfig | undefined {
  if (value === "" || value.includes("${")) return undefined;
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  if (url && (url.protocol === "postgres:" || url.protocol === "postgresql:") && url.pathname.length > 1) {
    return { kind: "postgres", url: value, template: true };
  }
  if (url && (url.protocol === "redis:" || url.protocol === "rediss:") && /^\/?\d*$/.test(url.pathname)) {
    return { kind: "redis", url: value };
  }
  if (SQLITE_VALUE.test(value) && !/^[a-z]+:\/\//i.test(value)) return { kind: "sqlite", path: value };
  return undefined;
}

export function detectDatabases(root: string, envFrom: string | undefined): Record<string, DatabaseConfig> {
  const databases: Record<string, DatabaseConfig> = {};
  if (!envFrom) return databases;
  for (const line of readFileSync(join(root, envFrom), "utf8").split(/\r?\n/)) {
    const match = ENV_VALUE.exec(line);
    if (!match?.[1] || match[2] === undefined || match[1] in databases) continue;
    const db = detectDatabase(match[2]);
    if (db) databases[match[1]] = db;
  }
  return databases;
}

const ENV_PORT = /^\s*(?:export\s+)?((?:[A-Z_][A-Z0-9_]*)?PORT)\s*=\s*["']?(\d{2,5})["']?\s*$/;
const SCRIPT_PORTS = [/--port[= ](\d{2,5})\b/g, /(?:^|\s)-p\s+(\d{2,5})\b/g, /\bPORT=(\d{2,5})\b/g];

function validPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function scriptVariable(script: string): string {
  const base = script.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const name = /^[0-9]/.test(base) ? `_${base}` : base;
  return name ? `${name}_PORT` : "PORT";
}

function readScripts(root: string): Record<string, string> {
  const file = join(root, "package.json");
  if (!existsSync(file)) return {};
  try {
    const pkg = JSON.parse(readFileSync(file, "utf8")) as { scripts?: Record<string, unknown> };
    const scripts: Record<string, string> = {};
    for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
      if (typeof command === "string") scripts[name] = command;
    }
    return scripts;
  } catch {
    return {};
  }
}

export function detectPorts(root: string): Detection {
  const ports: Record<string, number> = {};
  const skipped: string[] = [];
  const compose = COMPOSE_FILES.some((name) => existsSync(join(root, name)));
  const envFrom = ENV_TEMPLATES.find((name) => existsSync(join(root, name)));
  if (envFrom) {
    for (const line of readFileSync(join(root, envFrom), "utf8").split(/\r?\n/)) {
      const match = ENV_PORT.exec(line);
      if (!match?.[1] || !match[2]) continue;
      const port = Number(match[2]);
      if (!validPort(port) || match[1] in ports) continue;
      if (!compose && (SERVICE_PORTS.has(port) || SERVICE_NAME.test(match[1]))) {
        skipped.push(match[1]);
        continue;
      }
      ports[match[1]] = port;
    }
  }

  const fromScripts: Array<[string, number]> = [];
  const hardcoded: string[] = [];
  for (const [name, command] of Object.entries(readScripts(root))) {
    let found = false;
    for (const pattern of SCRIPT_PORTS) {
      for (const match of command.matchAll(pattern)) {
        const port = Number(match[1]);
        if (!validPort(port)) continue;
        found = true;
        fromScripts.push([name, port]);
      }
    }
    if (found) hardcoded.push(name);
  }

  const known = new Set(Object.values(ports));
  const fresh = fromScripts.filter(([, port]) => !known.has(port));
  if (Object.keys(ports).length === 0 && new Set(fresh.map(([, port]) => port)).size === 1) {
    ports.PORT = fresh[0]![1];
  } else {
    for (const [script, port] of fresh) {
      if (known.has(port)) continue;
      let variable = scriptVariable(script);
      for (let index = 2; variable in ports; index += 1) variable = `${scriptVariable(script).slice(0, -5)}_${index}_PORT`;
      ports[variable] = port;
      known.add(port);
    }
  }

  const detected = Object.keys(ports).length > 0;
  const result: Detection = {
    ports: detected ? ports : { ...DEFAULT_PORTS },
    databases: detectDatabases(root, envFrom),
    compose,
    hardcoded,
    skipped,
    detected,
  };
  if (envFrom) result.envFrom = envFrom;
  return result;
}
