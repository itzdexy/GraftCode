import type { SessionStatus } from '@shared/schemas/sessions';

export interface PowerBlocker {
  start(): number;
  stop(id: number): void;
}

/**
 * "Keep computer awake" per session: while any session that asked for it is
 * working, the system is kept from sleeping (the display may still turn off).
 * Nothing is persisted; the choice lasts until the app quits.
 */
export class KeepAwake {
  private readonly wanted = new Set<string>();
  private readonly busy = new Set<string>();
  private blocker: number | null = null;

  constructor(private readonly power: PowerBlocker) {}

  set(sessionId: string, on: boolean): boolean {
    if (on) this.wanted.add(sessionId);
    else this.wanted.delete(sessionId);
    this.apply();
    return on;
  }

  list(): string[] {
    return [...this.wanted];
  }

  /** Follows session status changes: running or waiting for input counts as working. */
  status(sessionId: string, status: SessionStatus): void {
    if (status === 'running' || status === 'needs-input') this.busy.add(sessionId);
    else this.busy.delete(sessionId);
    this.apply();
  }

  forget(sessionId: string): void {
    this.wanted.delete(sessionId);
    this.busy.delete(sessionId);
    this.apply();
  }

  /** True while the system is being kept awake. */
  get active(): boolean {
    return this.blocker !== null;
  }

  private apply(): void {
    const needed = [...this.wanted].some((id) => this.busy.has(id));
    if (needed && this.blocker === null) this.blocker = this.power.start();
    else if (!needed && this.blocker !== null) {
      this.power.stop(this.blocker);
      this.blocker = null;
    }
  }

  dispose(): void {
    this.wanted.clear();
    this.busy.clear();
    this.apply();
  }
}
