/** One part of quitting: what to tidy up, and how long it may take. */
export interface Stage {
  name: string;
  limitMs: number;
  run: () => unknown;
}

export interface StageReport {
  stage: string;
  ms: number;
  outcome: 'done' | 'failed' | 'timed out';
  error: string | null;
}

/**
 * Runs the stages of quitting in order. A stage that fails, or does not finish in its time,
 * is noted and left behind: one stuck or broken part must not keep the app from closing (a
 * Graft that never exits can't be started again), nor the later parts from being tidied up
 * (a server that fails to stop must not leave the user's commands running).
 */
export async function runStages(stages: Stage[], now: () => number = Date.now): Promise<StageReport[]> {
  const reports: StageReport[] = [];
  for (const stage of stages) {
    const startedAt = now();
    let limit: NodeJS.Timeout | undefined;
    const late = new Promise<'timed out'>((resolve) => {
      limit = setTimeout(() => resolve('timed out'), stage.limitMs);
    });
    // Started inside a promise so that a stage that throws at once is a failure like any other.
    const work = Promise.resolve().then(() => stage.run());
    let outcome: StageReport['outcome'];
    let error: string | null = null;
    try {
      outcome = await Promise.race([work.then(() => 'done' as const), late]);
    } catch (failure) {
      outcome = 'failed';
      error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      clearTimeout(limit);
    }
    // Whatever a stage does after it was given up on is nobody's to handle.
    work.catch(() => undefined);
    reports.push({ stage: stage.name, ms: now() - startedAt, outcome, error });
  }
  return reports;
}
