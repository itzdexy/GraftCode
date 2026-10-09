import { z } from 'zod';

export const SemanticQuerySchema = z.object({
  action: z.enum(['outline', 'definition', 'references', 'hover', 'diagnostics']),
  file: z.string().min(1).max(4096),
  line: z.number().int().min(1).optional(),
  column: z.number().int().min(1).optional()
});
export type SemanticQuery = z.infer<typeof SemanticQuerySchema>;
const CodeLocationSchema = z.object({ file: z.string().max(4096), line: z.number().int().positive(), column: z.number().int().positive() });
export const SemanticResultSchema = z.object({
  engine: z.literal('typescript-language-server'), file: z.string().max(4096),
  action: SemanticQuerySchema.shape.action,
  locations: z.array(CodeLocationSchema).max(1000).optional(),
  symbols: z.array(CodeLocationSchema.extend({ name: z.string().max(300), kind: z.number() })).max(500).optional(),
  diagnostics: z.array(CodeLocationSchema.extend({ severity: z.number(), code: z.union([z.string(), z.number()]).nullable(), message: z.string().max(4000) })).max(500).optional(),
  hover: z.string().max(16_000).optional(), truncated: z.boolean()
});
export type CodeLocation = z.infer<typeof CodeLocationSchema>;
export type SemanticResult = z.infer<typeof SemanticResultSchema>;
