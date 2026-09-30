/**
 * Error with a stable machine-readable code. Used in main-process modules and
 * serialized across IPC as { code, message, details }.
 */
export class GraftError extends Error {
  readonly code: string;
  readonly details: Record<string, string | number | boolean | null> | undefined;

  constructor(
    code: string,
    message: string,
    options?: { cause?: unknown; details?: Record<string, string | number | boolean | null> }
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'GraftError';
    this.code = code;
    this.details = options?.details;
  }
}

export function isGraftError(value: unknown): value is GraftError {
  return value instanceof GraftError;
}

/** Best-effort human message for any thrown value. */
export function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
