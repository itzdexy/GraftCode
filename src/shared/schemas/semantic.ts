import { z } from 'zod';

export const SemanticQuerySchema = z.object({
  action: z.enum(['outline', 'definition', 'references', 'hover', 'diagnostics', 'symbol', 'implementation', 'typeDefinition', 'rename']),
  file: z.string().min(1).max(4096),
  line: z.number().int().min(1).optional(),
  column: z.number().int().min(1).optional(),
  /** For `symbol`: the name to find in the project that `file` belongs to, or the start of one. */
  name: z.string().min(1).max(200).optional(),
  /** For `rename`: the new name. Left out, the answer is only where the name to rename is and how it is written. */
  newName: z.string().min(1).max(200).regex(/^[^\r\n]+$/).optional()
});
export type SemanticQuery = z.infer<typeof SemanticQuerySchema>;
const CodeLocationSchema = z.object({ file: z.string().max(4096), line: z.number().int().positive(), column: z.number().int().positive() });
/** A range of a file's text and what replaces it: lines and columns are 1-based, columns count UTF-16 units. */
const TextEditSchema = z.object({ line: z.number().int().positive(), column: z.number().int().positive(), endLine: z.number().int().positive(), endColumn: z.number().int().positive(), text: z.string().max(10_000) });
/** The edits a rename makes in one file. `revision` is the file the server saw (sha256 of its bytes); null for the editor's unsaved text. */
export const FileEditsSchema = z.object({ file: z.string().min(1).max(4096), revision: z.string().regex(/^[a-f0-9]{64}$/).nullable(), edits: z.array(TextEditSchema).min(1).max(5000) });
export type FileEdits = z.infer<typeof FileEditsSchema>;
export type TextEdit = z.infer<typeof TextEditSchema>;
export const SemanticResultSchema = z.object({
  engine: z.literal('typescript-language-server'), file: z.string().max(4096),
  action: SemanticQuerySchema.shape.action,
  locations: z.array(CodeLocationSchema).max(1000).optional(),
  symbols: z.array(CodeLocationSchema.extend({ name: z.string().max(300), kind: z.number(), container: z.string().max(300).optional() })).max(500).optional(),
  diagnostics: z.array(CodeLocationSchema.extend({ severity: z.number(), code: z.union([z.string(), z.number()]).nullable(), message: z.string().max(4000) })).max(500).optional(),
  hover: z.string().max(16_000).optional(), truncated: z.boolean(),
  /** `rename` without a new name: where the name is, `text` being the name as written. */
  span: TextEditSchema.optional(),
  /** `rename` with a new name: what changes in each file. */
  edits: z.array(FileEditsSchema).max(200).optional()
});
export type CodeLocation = z.infer<typeof CodeLocationSchema>;

/**
 * The errors and warnings of the files a session has changed. `ok`: a check ran; `checked` files answered, those with
 * problems are in `files`, and every file that could not be checked is in `unchecked` with the reason. The other
 * states say why nothing was checked: the project is not trusted, its packages are not installed, or no changed
 * file is TypeScript or JavaScript.
 */
export const ChangedProblemsSchema = z.object({
  state: z.enum(['ok', 'untrusted', 'no-packages', 'none']),
  checked: z.number().int().nonnegative(),
  files: z.array(z.object({ path: z.string(), problems: z.array(z.object({ line: z.number().int(), column: z.number().int(), severity: z.enum(['error', 'warning']), code: z.union([z.string(), z.number()]).nullable(), text: z.string() })) })),
  unchecked: z.array(z.object({ path: z.string(), reason: z.string() }))
});
export type ChangedProblems = z.infer<typeof ChangedProblemsSchema>;
export type SemanticResult = z.infer<typeof SemanticResultSchema>;
