/**
 * The language server's numbers for kinds of symbol (LSP SymbolKind), as
 * words: a model reads them without the table, and so does a person in the
 * list of symbols.
 */
const KINDS = ['', 'file', 'module', 'namespace', 'package', 'class', 'method', 'property', 'field', 'constructor', 'enum', 'interface', 'function', 'variable', 'constant', 'string', 'number', 'boolean', 'array', 'object', 'key', 'null', 'enum member', 'struct', 'event', 'operator', 'type parameter'];

/** The word for a kind; "symbol" for a number the table does not know. */
export function symbolKind(kind: number): string {
  return KINDS[kind] || 'symbol';
}
