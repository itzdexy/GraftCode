import path from 'node:path';
import { SemanticQuerySchema, type SemanticQuery } from '../../languages/types';
import type { LanguageServers } from '../../languages/servers';
import { errorResult, textResult, type ToolDefinition } from '../types';

/** The server's numbers for kinds of symbol (LSP SymbolKind), as words a model reads without the table. */
const KINDS = ['', 'file', 'module', 'namespace', 'package', 'class', 'method', 'property', 'field', 'constructor', 'enum', 'interface', 'function', 'variable', 'constant', 'string', 'number', 'boolean', 'array', 'object', 'key', 'null', 'enum member', 'struct', 'event', 'operator', 'type parameter'];

/** Semantic answers use a real local server; text-pattern Symbols remains available for other languages. */
export function semanticCodeTool(servers: LanguageServers | null): ToolDefinition<SemanticQuery> {
  return {
    name: 'SemanticCode',
    description: [
      'Queries the local TypeScript/JavaScript language server, which knows the code exactly: it resolves imports and tells same-named things apart.',
      'symbol: finds declarations by name across the project (give name, and as file any source file of that project). Each place it returns is on the name itself, so it can be passed straight to references, definition or implementation.',
      'outline: the declarations of one file. diagnostics: the current errors of one file (not a project-wide check).',
      'definition, references, implementation (the classes and methods that implement an interface or an abstract member), typeDefinition (where the type of a value is declared) and hover (its type and documentation): give file plus the 1-based line and column (UTF-16) of a name.',
      'Give file relative to the project. Requires a trusted project, runs locally, and never applies edits. Returned locations are confined to the project. Use Symbols or Grep for other languages.'
    ].join(' '),
    input: SemanticQuerySchema,
    permissionClass: 'read',
    concurrencySafe: () => true,
    timeoutMs: 60_000,
    describe: (input, ctx) => Promise.resolve({ summary: `Semantic ${input.action}: ${input.action === 'symbol' ? (input.name ?? '') : input.file}`,
      reads: [ctx.projectRoot, path.resolve(ctx.projectRoot, input.file)], preview: { kind: 'path', path: path.resolve(ctx.projectRoot, input.file), access: 'read' } }),
    async execute(input, ctx) {
      if (!ctx.trustedProject) return errorResult('Semantic analysis requires a trusted code project. Trust the project or use Read, Symbols and Grep.');
      if (!servers) return errorResult('The local language-server runtime is unavailable. Use Symbols or Grep.');
      try {
        const result = await servers.query(ctx.projectRoot, input, ctx.signal);
        const text = JSON.stringify(result.symbols ? { ...result, symbols: result.symbols.map((symbol) => ({ ...symbol, kind: KINDS[symbol.kind] ?? symbol.kind })) } : result, null, 2);
        const count = result.locations?.length ?? result.symbols?.length ?? result.diagnostics?.length ?? (result.hover ? 1 : 0);
        return textResult(text, { kind: 'grep', pattern: `Semantic ${input.action}: ${input.action === 'symbol' ? (input.name ?? '') : input.file}`, count, preview: text.slice(0, 16_000) });
      } catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
    }
  };
}
