export function redact(value: string): string {
  return value
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^:/@\s]*:)[^@/\s]+@/gi, "$1***@")
    .replace(/([?&])([^?&=\s"'<>#]+)=[^&\s"<>#]*/g, (param, separator: string, key: string) =>
      new URLSearchParams(`${key}=`).has("password") ? `${separator}${key}=***` : param,
    );
}
