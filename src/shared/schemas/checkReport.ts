import { z } from 'zod';

/** The project's checks after a turn changed files (meta of a "check" message): each command run, in order. */
export const CheckReportSchema = z.object({
  passed: z.boolean(),
  runs: z.array(
    z.object({
      command: z.string(),
      exitCode: z.number().int().nullable(),
      /** The end of the output. */
      output: z.string(),
      truncated: z.boolean(),
      durationMs: z.number(),
      timedOut: z.boolean(),
      passed: z.boolean()
    })
  ),
  /** 1 for the checks after the turn's work, 2 and up after each round of fixes. */
  round: z.number().int().min(1)
});
export type CheckReport = z.infer<typeof CheckReportSchema>;
