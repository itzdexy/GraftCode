/**
 * Suggestions as you type, on the renderer's side and without Monaco: a small cache keyed by the text around
 * the cursor (retyping or undoing does not ask again), a request that is cancelled when typing goes on, and a
 * pause after a failure whose reason is shown once. Pure, so it is unit-tested without a DOM.
 */

/** Files larger than this get no suggestions. */
export const BIG_FILE = 1_000_000;
/** Suggestions remembered per editor. */
const CACHE_SIZE = 64;
/** The first pause after a failure, doubled with each failure in a row up to the last. */
const FIRST_PAUSE_MS = 30_000;
const LONGEST_PAUSE_MS = 5 * 60_000;

/** Monaco's cancellation token, as far as it is used here. */
export interface CancelToken {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

/** A suggestion is remembered by the file and the text right around the cursor. */
export function suggestionKey(file: string, prefix: string, suffix: string): string {
  return `${file}\u0000${prefix.slice(-500)}\u0000${suffix.slice(0, 200)}`;
}

export class Suggestions {
  private readonly cache = new Map<string, string>();
  private pausedUntil = 0;
  private failures = 0;
  /** Off for the rest of this editor's life: the file may hold secrets. */
  private off = false;
  private shown: string | null = null;

  constructor(
    private readonly io: {
      /** Ends a request in the main process. */
      cancel(requestId: string): void;
      /** Shows why suggestions stopped, or clears that with null. */
      note(text: string | null): void;
      newId?: () => string;
      now?: () => number;
    }
  ) {}

  /** Whether a request may go out now. */
  ready(): boolean {
    return !this.off && (this.io.now?.() ?? Date.now()) >= this.pausedUntil;
  }

  /** The suggestion for `key`: remembered, else asked for. Null when there is none to show or the request was cancelled. */
  async suggest(key: string, ask: (requestId: string) => Promise<string>, token: CancelToken): Promise<string | null> {
    if (!this.ready()) return null;
    const known = this.cache.get(key);
    if (known !== undefined) {
      // Most recently used last, so the oldest goes first when the cache is full.
      this.cache.delete(key);
      this.cache.set(key, known);
      return known || null;
    }
    const requestId = this.io.newId?.() ?? crypto.randomUUID();
    const cancel = token.onCancellationRequested(() => this.io.cancel(requestId));
    try {
      const text = await ask(requestId);
      // An answer that came after all is still right for its place: kept for when the cursor is back there.
      this.cache.set(key, text);
      if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value ?? key);
      this.failures = 0;
      this.show(null);
      return token.isCancellationRequested || !text ? null : text;
    } catch (error) {
      if (!token.isCancellationRequested) this.failed(error);
      return null;
    } finally {
      cancel.dispose();
    }
  }

  private failed(error: unknown): void {
    const { code, message } = error as { code?: unknown; message?: unknown };
    if (code === 'cancelled') return;
    if (code === 'secret_file') {
      this.off = true;
      this.show('Suggestions are off for this file: it may hold keys or passwords.');
      return;
    }
    // No model, a refused key, no network: stop asking for a while instead of failing at every pause in typing.
    this.failures++;
    this.pausedUntil = (this.io.now?.() ?? Date.now()) + Math.min(FIRST_PAUSE_MS * 2 ** (this.failures - 1), LONGEST_PAUSE_MS);
    this.show(`Suggestions paused: ${typeof message === 'string' && message ? message : 'the model could not be reached.'}`);
  }

  /** Each reason once: the same failure again says nothing new. */
  private show(text: string | null): void {
    if (this.shown === text) return;
    this.shown = text;
    this.io.note(text);
  }
}
