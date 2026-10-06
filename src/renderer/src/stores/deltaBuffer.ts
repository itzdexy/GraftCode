import type { AgentEvent } from '@shared/schemas/agentEvents';

export type AssistantDelta = Extract<AgentEvent, { type: 'assistant-delta' }>;

/**
 * Streamed text arrives in many small pieces, far more often than the page
 * repaints. The buffer holds them until the next frame and hands them over
 * joined, so a fast model costs one update per frame instead of one per piece.
 * `schedule` asks for that frame; `apply` gets a session's pieces in order.
 */
export function createDeltaBuffer(apply: (sessionId: string, deltas: AssistantDelta[]) => void, schedule: (run: () => void) => void) {
  const waiting = new Map<string, AssistantDelta[]>();
  let scheduled = false;

  const flush = (sessionId: string): void => {
    const deltas = waiting.get(sessionId);
    if (!deltas) return;
    waiting.delete(sessionId);
    apply(sessionId, deltas);
  };

  return {
    push(sessionId: string, delta: AssistantDelta): void {
      const deltas = waiting.get(sessionId) ?? [];
      const last = deltas.at(-1);
      if (last && last.messageId === delta.messageId && last.kind === delta.kind) deltas[deltas.length - 1] = { ...last, text: last.text + delta.text };
      else deltas.push(delta);
      waiting.set(sessionId, deltas);
      if (scheduled) return;
      scheduled = true;
      schedule(() => {
        scheduled = false;
        for (const id of [...waiting.keys()]) flush(id);
      });
    },
    /** Applies a session's waiting text now: whatever happens to the session next has to come after its text. */
    flush
  };
}
