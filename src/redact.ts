export function redact(value: string): string {
  return value.replace(/([a-z][a-z0-9+.-]*:\/\/[^:/@\s]*:)[^@/\s]+@/gi, "$1***@");
}
