import type { StoredMessage } from '@shared/schemas/messages';
import type { SessionStore } from '../db/sessionsRepo';
import { withPrunedOutput } from './prune';

/** Durable request shaping. Transcript content always remains intact. */
export class SessionContextState {
  private beforeSeq: number;

  constructor(private readonly store: SessionStore, private readonly sessionId: string) {
    this.beforeSeq = store.getPruneBeforeSeq(sessionId);
  }

  get cutoff(): number {
    return this.beforeSeq;
  }

  output(messages: StoredMessage[], cutoff = this.beforeSeq): StoredMessage[] {
    return withPrunedOutput(messages, cutoff);
  }

  setCutoff(seq: number): void {
    this.store.setPruneBeforeSeq(this.sessionId, seq);
    this.beforeSeq = seq;
  }

  rewind(seq: number): void {
    this.setCutoff(Math.min(this.beforeSeq, seq));
  }
}
