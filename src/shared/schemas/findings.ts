import { z } from 'zod';

/**
 * What a code review found (the ReportFindings tool): one problem per finding,
 * kept with the turn like any tool result and drawn as a card the user acts on.
 */

/** high: it breaks something, loses data or opens a hole. medium: a real bug in a less common case. low: minor, still worth fixing. */
export const FINDING_SEVERITIES = ['high', 'medium', 'low'] as const;
export const FindingSeveritySchema = z.enum(FINDING_SEVERITIES);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

/** A finding as Graft keeps it: the file from the project folder, the lines in order, and what to do about it. */
export const FindingSchema = z.object({
  path: z.string(),
  line: z.number().int().min(1),
  endLine: z.number().int().min(1),
  severity: FindingSeveritySchema,
  title: z.string(),
  /** The concrete failure: what input or state leads to what wrong result. */
  detail: z.string(),
  suggestion: z.string().nullable()
});
export type Finding = z.infer<typeof FindingSchema>;

/** Worst first. */
export const SEVERITY_RANK: Record<FindingSeverity, number> = { high: 0, medium: 1, low: 2 };
