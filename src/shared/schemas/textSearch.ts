import { z } from 'zod';

/** A search for text in the files of a session's folder (the Search tab). */
export const TextSearchQuerySchema = z.object({
  text: z.string().min(1).max(1000),
  /** `text` is a regular expression; otherwise it is looked for as it is written. */
  regex: z.boolean(),
  caseSensitive: z.boolean(),
  wholeWord: z.boolean(),
  /** Globs separated by commas: the files to look in, or with "!" in front, the files to leave out. */
  files: z.string().max(1000)
});
export type TextSearchQuery = z.infer<typeof TextSearchQuerySchema>;

export const TextSearchMatchSchema = z.object({
  line: z.number().int().positive(),
  /** Where the first match starts in the line of the file, counted in characters from 1. */
  column: z.number().int().positive(),
  /** The line as it is shown: without its indentation, and around the first match when it is long. */
  text: z.string().max(400),
  /** Where the matches are in `text`: start and end, in characters. */
  ranges: z.array(z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])).max(50)
});
export type TextSearchMatch = z.infer<typeof TextSearchMatchSchema>;

export const TextSearchResultSchema = z.object({
  /** In the order of their paths, from the folder, with "/". */
  files: z.array(z.object({ path: z.string().max(4096), matches: z.array(TextSearchMatchSchema) })),
  /** The lines listed, over all files. */
  lines: z.number().int().nonnegative(),
  /** The search stopped before it was through: there may be more than is listed. */
  truncated: z.boolean()
});
export type TextSearchResult = z.infer<typeof TextSearchResultSchema>;
