import { NocollideError } from "./errors.js";

export type ShellKind = "sh" | "powershell" | "cmd" | "json";

export function parseShell(value: string | undefined): ShellKind {
  if (value === undefined) return process.platform === "win32" && !process.env.SHELL ? "powershell" : "sh";
  const normalized = value.toLowerCase();
  if (["sh", "bash", "zsh", "fish"].includes(normalized)) return "sh";
  if (["powershell", "pwsh", "ps"].includes(normalized)) return "powershell";
  if (normalized === "cmd") return "cmd";
  if (normalized === "json") return "json";
  throw new NocollideError(`Unknown shell "${value}". Use sh, powershell, cmd or json.`);
}

export function formatVars(vars: Record<string, string>, shell: ShellKind): string {
  if (shell === "json") return `${JSON.stringify(vars, null, 2)}\n`;
  const lines = Object.entries(vars).map(([name, value]) => {
    if (shell === "powershell") return `$env:${name} = '${value.replace(/'/g, "''")}'`;
    if (shell === "cmd") return `set "${name}=${value}"`;
    return `export ${name}='${value.replace(/'/g, "'\\''")}'`;
  });
  return `${lines.join("\n")}\n`;
}
