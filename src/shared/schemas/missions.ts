import { z } from 'zod';
import { CheckReportSchema } from './messages';

/**
 * A mission: an objective a code session keeps working on, turn after turn,
 * until it is finished and its checks pass. It is kept with the session, so
 * it survives a restart, and the agent's notebook travels with every turn, so
 * it survives a compacted context.
 */

export const MISSION_LIMITS = {
  objective: 4000,
  criteria: 12,
  criterion: 400,
  checks: 6,
  check: 2000,
  minTurns: 1,
  maxTurns: 200,
  defaultTurns: 25,
  /** Turns added when a mission that used all of its turns is resumed. */
  moreTurns: 10,
  notes: 200,
  note: 1200,
  summary: 4000
} as const;

export const MissionStatusSchema = z.enum(['active', 'paused', 'done', 'cancelled']);
export type MissionStatus = z.infer<typeof MissionStatusSchema>;

export const MissionNoteKindSchema = z.enum(['discovery', 'decision', 'blocker', 'progress']);
export type MissionNoteKind = z.infer<typeof MissionNoteKindSchema>;

export const MissionNoteSchema = z.object({ kind: MissionNoteKindSchema, text: z.string(), at: z.number().int() });
export type MissionNote = z.infer<typeof MissionNoteSchema>;

/** What the user gives to start one. The checks are theirs alone: the agent can't add, change or drop them. */
export const MissionStartSchema = z.object({
  objective: z.string().trim().min(1).max(MISSION_LIMITS.objective),
  /** What "done" means, in words. */
  criteria: z.array(z.string().trim().min(1).max(MISSION_LIMITS.criterion)).max(MISSION_LIMITS.criteria),
  /** Commands that must pass before the mission counts as done. */
  checks: z.array(z.string().trim().min(1).max(MISSION_LIMITS.check)).max(MISSION_LIMITS.checks),
  maxTurns: z.number().int().min(MISSION_LIMITS.minTurns).max(MISSION_LIMITS.maxTurns)
});
export type MissionStart = z.infer<typeof MissionStartSchema>;

export const MissionSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  objective: z.string(),
  criteria: z.array(z.string()),
  checks: z.array(z.string()),
  status: MissionStatusSchema,
  /** Why it is paused, in a sentence; null otherwise. */
  reason: z.string().nullable(),
  /** Turns the agent has started on it. */
  turns: z.number().int(),
  maxTurns: z.number().int(),
  /** The agent reported it done; the checks have yet to agree. */
  claimed: z.boolean(),
  /** The agent's summary of the finished work. */
  result: z.string(),
  /** What the agent recorded as it worked: the newest entries. */
  notebook: z.array(MissionNoteSchema),
  /** The last run of the checks; null before the first. */
  verification: CheckReportSchema.nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  endedAt: z.number().int().nullable(),
  /** Counts the changes, so a view that hears two of them out of order keeps the later one. */
  rev: z.number().int()
});
export type Mission = z.infer<typeof MissionSchema>;

/** Still going or waiting to be resumed: the session offers the mission tool and shows the mission bar. */
export function missionOpen(status: MissionStatus): boolean {
  return status === 'active' || status === 'paused';
}
