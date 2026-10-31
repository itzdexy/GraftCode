import { z } from 'zod';
import { GraftError } from '@shared/errors';
import type { TextEdit } from '@shared/schemas/semantic';

const Position = z.object({ line: z.number().int().nonnegative(), character: z.number().int().nonnegative() });
const LspTextEdit = z.object({ range: z.object({ start: Position, end: Position }), newText: z.string() });
const WorkspaceEdit = z.object({ changes: z.record(z.string(), z.array(LspTextEdit)).optional(), documentChanges: z.array(z.unknown()).optional() });
const TextDocumentEdit = z.object({ textDocument: z.object({ uri: z.string() }), edits: z.array(LspTextEdit) });

/**
 * The text edits of a language server's WorkspaceEdit (the answer to textDocument/rename), by file. `locate` names
 * the project file a URI is, or null when it is not one; such a file, or an edit that would create, move or delete
 * a file, refuses the whole rename. Positions become 1-based, as the editor counts them.
 */
export function renameEdits(edit: unknown, locate: (uri: string) => string | null): Map<string, TextEdit[]> {
  const files = new Map<string, TextEdit[]>();
  if (edit === null || edit === undefined) return files;
  const parsed = WorkspaceEdit.safeParse(edit);
  if (!parsed.success) throw new GraftError('language_rename', 'The language server answered with a rename the editor cannot read, so nothing was changed.');
  const byUri: Array<[string, Array<z.infer<typeof LspTextEdit>>]> = Object.entries(parsed.data.changes ?? {});
  for (const change of parsed.data.documentChanges ?? []) {
    const document = TextDocumentEdit.safeParse(change);
    if (!document.success) throw new GraftError('language_rename', 'This rename would create, move or delete files. Ask the agent to make it instead.');
    byUri.push([document.data.textDocument.uri, document.data.edits]);
  }
  for (const [uri, edits] of byUri) {
    if (edits.length === 0) continue;
    const file = locate(uri);
    if (file === null) throw new GraftError('language_path', 'This rename would change files outside the project, so nothing was changed.');
    const list = files.get(file) ?? [];
    for (const { range, newText } of edits) {
      list.push({ line: range.start.line + 1, column: range.start.character + 1, endLine: range.end.line + 1, endColumn: range.end.character + 1, text: newText });
    }
    files.set(file, list);
  }
  return files;
}
