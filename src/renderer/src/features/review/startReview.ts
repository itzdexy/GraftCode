import { invoke } from '../../lib/ipc';
import { reportError } from '../../stores/toasts';

/**
 * Asks a session's agent for a review, as typing the command would: behind a
 * running turn it waits in the queue. `branch` reviews the branch's work since
 * it left the default branch, as the Changes card counts it; otherwise the
 * uncommitted changes, as the Changes panel lists them.
 */
export function startReview(sessionId: string, scope: 'uncommitted' | 'branch'): void {
  invoke('sessions:send', { id: sessionId, text: scope === 'branch' ? '/review branch' : '/review', images: [], files: [] }).catch((error: unknown) =>
    reportError("Couldn't start the review", error)
  );
}
