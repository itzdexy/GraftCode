import { z } from 'zod';

export const ChangedFileSchema = z.object({
  path: z.string(),
  origPath: z.string().nullable(),
  staged: z.enum(['M', 'A', 'D', 'R', 'C', 'T']).nullable(),
  unstaged: z.enum(['M', 'D', 'T']).nullable(),
  untracked: z.boolean(),
  conflicted: z.boolean()
});
export type ChangedFileView = z.infer<typeof ChangedFileSchema>;

export const HunkSchema = z.object({
  header: z.string(),
  lines: z.array(z.string()),
  oldStart: z.number().int(),
  newStart: z.number().int()
});
export type HunkView = z.infer<typeof HunkSchema>;

export const FileDiffSchema = z.object({
  path: z.string(),
  staged: z.boolean(),
  binary: z.boolean(),
  header: z.string(),
  hunks: z.array(HunkSchema),
  added: z.number().int(),
  removed: z.number().int()
});
export type FileDiffView = z.infer<typeof FileDiffSchema>;

export const GitStatusSchema = z.object({
  isRepo: z.boolean(),
  workDir: z.string(),
  branch: z.string().nullable(),
  files: z.array(ChangedFileSchema)
});
export type GitStatusView = z.infer<typeof GitStatusSchema>;

export const PullRequestResultSchema = z.object({
  url: z.string(),
  /** "gh": created with the GitHub CLI; "browser": finish on the host's compare page. */
  via: z.enum(['gh', 'browser'])
});
export type PullRequestView = z.infer<typeof PullRequestResultSchema>;
