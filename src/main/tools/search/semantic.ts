import path from 'node:path';
import { SemanticQuerySchema, type SemanticQuery } from '../../languages/types';
import type { LanguageServers } from '../../languages/servers';
import { errorResult, textResult, type ToolDefinition } from '../types';

/** Semantic answers use a real local server; text-pattern Symbols remains available for other languages. */
export function semanticCodeTool(servers: LanguageServers | null): ToolDefinition<SemanticQuery> {
  return {
    name: 'SemanticCode',
    description: 'Queries the local TypeScript/JavaScript language server for an exact file outline, definition, references, type hover or current diagnostics. Give file relative to the project; definition/references/hover need 1-based line and column (UTF-16). It resolves imported symbols and distinguishes same-named variables. Requires a trusted project, runs locally, and never applies edits. Use Symbols/Grep for other languages. Returned locations are confined to the project; diagnostics are per requested file, not a project-wide test result.',
    input: SemanticQuerySchema,
    permissionClass: 'read',
    concurrencySafe: () => true,
    timeoutMs: 60_000,
    describe: (input, ctx) => Promise.resolve({ summary: `Semantic ${input.action}: ${input.file}`,
      reads: [ctx.projectRoot, path.resolve(ctx.projectRoot, input.file)], preview: { kind: 'path', path: path.resolve(ctx.projectRoot, input.file), access: 'read' } }),
    async execute(input, ctx) {
      if (!ctx.trustedProject) return errorResult('Semantic analysis requires a trusted code project. Trust the project or use Read, Symbols and Grep.');
      if (!servers) return errorResult('The local language-server runtime is unavailable. Use Symbols or Grep.');
      try {
        const result = await servers.query(ctx.projectRoot, input, ctx.signal);
        const text = JSON.stringify(result, null, 2);
        const count = result.locations?.length ?? result.symbols?.length ?? result.diagnostics?.length ?? (result.hover ? 1 : 0);
        return textResult(text, { kind: 'grep', pattern: `Semantic ${input.action}: ${input.file}`, count, preview: text.slice(0, 16_000) });
      } catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
    }
  };
}
