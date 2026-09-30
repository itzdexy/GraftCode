/**
 * Envelope used for every invoke round-trip. Electron only preserves the
 * message of errors thrown across the IPC boundary, so failures travel as
 * data and the renderer rethrows them as GraftError with the code intact.
 */
export interface IpcError {
  code: string;
  message: string;
  /** Optional structured details (never secrets). */
  details?: Record<string, string | number | boolean | null>;
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: IpcError };

export const IPC_INVOKE = 'graft:invoke';
export const IPC_EVENT = 'graft:event';
