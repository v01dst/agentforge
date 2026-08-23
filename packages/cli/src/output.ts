const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  cyan: '\u001b[36m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  red: '\u001b[31m',
} as const;

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code: keyof typeof ANSI, value: string): string => useColor ? `${ANSI[code]}${value}${ANSI.reset}` : value;

export const info = (message: string): void => { process.stdout.write(`${message}\n`); };
export const success = (message: string): void => { info(paint('green', message)); };
export const warn = (message: string): void => { process.stderr.write(`${paint('yellow', message)}\n`); };
export const error = (message: string): void => { process.stderr.write(`${paint('red', message)}\n`); };
export const heading = (message: string): void => info(`\n${paint('bold', message)}`);
export const hint = (message: string): void => info(paint('dim', message));

export function printJson(value: unknown): void {
  info(JSON.stringify(value, (_key, item) => item instanceof Error ? { name: item.name, message: item.message } : item, 2));
}

export function redact(value: string): string {
  return value
    .replace(/(sk-[A-Za-z0-9_-]{8,})/g, '[REDACTED_KEY]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1[REDACTED]')
    .replace(/(api[_-]?key\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}

export function formatError(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return redact(message);
}
