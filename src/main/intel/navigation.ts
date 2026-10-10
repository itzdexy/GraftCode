/**
 * Where a symbol is defined and used, as a language server answers it, and
 * the reading of a TypeScript server's replies into that. Pure, so it is
 * unit-tested without a server.
 */

/** A place in a file (line and column count from 1). */
export interface CodeLocation {
  file: string;
  line: number;
  column: number;
}

/** One use of a symbol: where, the line it is on, and whether that line is where it is defined. */
export interface CodeReference extends CodeLocation {
  text: string;
  definition: boolean;
}

/** Exact answers about a symbol at a place in a file; null from either when the server cannot say. */
export interface CodeNavigator {
  definition(file: string, line: number, column: number): Promise<CodeLocation[] | null>;
  references(file: string, line: number, column: number): Promise<CodeReference[] | null>;
}

interface Span {
  file?: string;
  start?: { line?: number; offset?: number };
  lineText?: string;
  isDefinition?: boolean;
}

function place(span: Span): CodeLocation | null {
  if (typeof span.file !== 'string' || typeof span.start?.line !== 'number') return null;
  return { file: span.file, line: span.start.line, column: span.start.offset ?? 1 };
}

/** The reply to "definition": the places a symbol is declared. */
export function toLocations(body: unknown): CodeLocation[] {
  if (!Array.isArray(body)) return [];
  return (body as Span[]).flatMap((span) => {
    const at = span !== null && typeof span === 'object' ? place(span) : null;
    return at ? [at] : [];
  });
}

/** The reply to "references": every use of a symbol, its definition among them. */
export function toReferences(body: unknown): CodeReference[] {
  const refs = body !== null && typeof body === 'object' ? (body as { refs?: unknown }).refs : null;
  if (!Array.isArray(refs)) return [];
  return (refs as Span[]).flatMap((span) => {
    const at = span !== null && typeof span === 'object' ? place(span) : null;
    return at ? [{ ...at, text: typeof span.lineText === 'string' ? span.lineText : '', definition: span.isDefinition === true }] : [];
  });
}
