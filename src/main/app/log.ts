import fs from 'node:fs';
import path from 'node:path';

type Level = 'debug' | 'info' | 'warn' | 'error';
type Fields = Record<string, string | number | boolean | null | undefined>;

/**
 * Minimal structured logger. Lines go to stderr and, once configured, to a
 * rotating file in the app's log directory. Callers must never pass secrets;
 * `redact` scrubs anything that looks like an API key as a second line of
 * defense.
 */
let logFile: string | null = null;
const MAX_LOG_BYTES = 2 * 1024 * 1024;

const KEY_PATTERNS = [
  /sk-[A-Za-z0-9_-]{12,}/g,
  /sk-ant-[A-Za-z0-9_-]{12,}/g,
  /AIza[0-9A-Za-z_-]{20,}/g,
  /(bearer\s+)[A-Za-z0-9._-]+/gi,
  /(x-api-key["':\s]+)[A-Za-z0-9._-]{12,}/gi,
  /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)["']?\s*[:=]\s*["']?)([^\s"'&,;]+)/gi,
  /(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi
];

export function redact(text: string): string {
  let out = text;
  for (const pattern of KEY_PATTERNS) {
    out = out.replace(pattern, (match: string, prefix?: string) =>
      typeof prefix === 'string' && prefix.length > 0 && match.startsWith(prefix) ? `${prefix}[redacted]` : '[redacted]'
    );
  }
  return out;
}

export function configureLogFile(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  logFile = path.join(dir, 'graft.log');
  try {
    const stat = fs.statSync(logFile);
    if (stat.size > MAX_LOG_BYTES) fs.renameSync(logFile, `${logFile}.1`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function write(level: Level, scope: string, message: string, fields?: Fields): void {
  const suffix = fields
    ? ' ' +
      Object.entries(fields)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${JSON.stringify(/key|token|authorization|password|secret/i.test(k) ? '[redacted]' : v)}`)
        .join(' ')
    : '';
  const line = redact(`${new Date().toISOString()} ${level.toUpperCase()} [${scope}] ${message}${suffix}`);
  if (level === 'error' || level === 'warn' || process.env.GRAFT_LOG_STDERR === '1') process.stderr.write(`${line}\n`);
  if (logFile) {
    try {
      fs.appendFileSync(logFile, `${line}\n`);
    } catch (error) {
      process.stderr.write(`log write failed: ${(error as Error).message}\n`);
    }
  }
}

export const log = {
  debug: (scope: string, message: string, fields?: Fields) => write('debug', scope, message, fields),
  info: (scope: string, message: string, fields?: Fields) => write('info', scope, message, fields),
  warn: (scope: string, message: string, fields?: Fields) => write('warn', scope, message, fields),
  error: (scope: string, message: string, fields?: Fields) => write('error', scope, message, fields)
};
