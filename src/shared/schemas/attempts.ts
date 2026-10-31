import { z } from 'zod';
import { CheckReportSchema } from './checkReport';
import { ModelRefSchema, UsageSchema } from './common';

/**
 * A message sent as attempts (best of N): each attempt is a writing agent that
 * works on the same message in a private checkout of its own. They stop before
 * changing the session's folder; the card in the transcript compares them, and
 * the user applies one or discards them all. Kept on the card's message, so it
 * survives a restart with the conversation.
 */

/** How many attempts one message can be sent as. */
export const ATTEMPTS_MIN = 2;
export const ATTEMPTS_MAX = 4;

/** "candidate": it finished and its checks ran; it waits to be applied or discarded. */
export const AttemptStatusSchema = z.enum(['queued', 'running', 'checking', 'candidate', 'failed', 'stopped']);
export type AttemptStatus = z.infer<typeof AttemptStatusSchema>;

/** A file an attempt changed, named from the repository's root, with its line counts (none for a binary file). */
export const AttemptFileSchema = z.object({ path: z.string(), added: z.number().int(), removed: z.number().int(), binary: z.boolean() });
export type AttemptFile = z.infer<typeof AttemptFileSchema>;

export const AttemptSchema = z.object({
  /** 1 for the first attempt. */
  index: z.number().int().min(1),
  model: ModelRefSchema.extend({ label: z.string() }),
  status: AttemptStatusSchema,
  /** Why it failed or stopped. */
  error: z.string().nullable(),
  /** The record of its private checkout (agent/workspaces.ts); null until the checkout is made. */
  workspaceId: z.string().nullable(),
  /** What it is doing now, while it runs. */
  activity: z.string().nullable(),
  files: z.array(AttemptFileSchema),
  /** The project's checks, run in its checkout once it finished; null when none ran (`notes` says why). */
  checks: CheckReportSchema.nullable(),
  /** What the card says about it besides: no checks set up, edits to ignored files left out. */
  notes: z.array(z.string()),
  usage: UsageSchema,
  /** Null while nothing it used had a published price. */
  costUsd: z.number().nullable(),
  startedAt: z.number().int().nullable(),
  endedAt: z.number().int().nullable(),
  /** Its final words, shortened. */
  report: z.string()
});
export type Attempt = z.infer<typeof AttemptSchema>;

export const AttemptSetSchema = z.object({
  /** Also the id of the card's message. */
  id: z.string(),
  /** The message the attempts answer: its checkpoint holds the files as they were before one was applied. */
  messageId: z.string(),
  /** "open": nothing runs; an attempt can be applied, or all discarded. */
  status: z.enum(['running', 'open', 'applied', 'discarded']),
  /** The attempt that was applied. */
  applied: z.number().int().nullable(),
  /** Said once on the card: Graft stopped while they ran. */
  note: z.string().nullable(),
  attempts: z.array(AttemptSchema),
  createdAt: z.number().int()
});
export type AttemptSet = z.infer<typeof AttemptSetSchema>;
