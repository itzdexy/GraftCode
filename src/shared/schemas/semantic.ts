import { z } from 'zod';

export const SemanticQuerySchema = z.object({
  action: z.enum(['outline', 'definition', 'references', 'hover', 'diagnostics', 'symbol', 'implementation', 'typeDefinition']),
  file: z.string().min(1).max(4096),
  line: z.number().int().min(1).optional(),
  column: z.number().int().min(1).optional(),
  /** For `symbol`: the name to find in the project that `file` belongs to, or the start of one. */
  name: z.string().min(1).max(200).optional()
});
export type SemanticQuery = z.infer<typeof SemanticQuerySchema>;
const CodeLocationSchema = z.object({ file: z.string().max(4096), line: z.number().int().positive(), column: z.number().int().positive() });
export const SemanticResultSchema = z.object({
  engine: z.literal('typescript-language-server'), file: z.string().max(4096),
  action: SemanticQuerySchema.shape.action,
  locations: z.array(CodeLocationSchema).max(1000).optional(),
  symbols: z.array(CodeLocationSchema.extend({ name: z.string().max(300), kind: z.number(), container: z.string().max(300).optional() })).max(500).optional(),
  diagnostics: z.array(CodeLocationSchema.extend({ severity: z.number(), code: z.union([z.string(), z.number()]).nullable(), message: z.string().max(4000) })).max(500).optional(),
  hover: z.string().max(16_000).optional(), truncated: z.boolean()
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
