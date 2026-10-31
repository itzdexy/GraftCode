import * as monaco from 'monaco-editor/editor/editor.api.js';
import type { CodeLocation, FileEdits, SemanticQuery } from '@shared/schemas/semantic';
import { errorText, invoke } from '../../lib/ipc';
import { textChanges } from './textChanges';

/** Definitions in other files are named with this scheme; opening one goes to the Files panel instead of this editor. */
const OTHER_FILE = 'graft-file';
const LANGUAGES = ['typescript', 'javascript'];

const plural = (n: number): string => `${String(n)} file${n === 1 ? '' : 's'}`;

/**
 * Puts `text` into the editor as edits of the lines that differ, one undo step, so the cursor, the selection and the
 * scroll stay where they were and Ctrl+Z steps back. For text that comes from outside the editor (the file on disk).
 */
export function applyText(editor: monaco.editor.ICodeEditor, text: string): void {
  const model = editor.getModel();
  if (!model) return;
  const bom = '\ufeff';
  const target = text.startsWith(bom) ? text.slice(1) : text;
  const edits = textChanges(model.getValue(monaco.editor.EndOfLinePreference.TextDefined, false), target).map((change) => ({
    range: monaco.Range.fromPositions(model.getPositionAt(change.start), model.getPositionAt(change.end)),
    text: change.text
  }));
  if (!edits.length) return;
  editor.pushUndoStop();
  editor.executeEdits('graft.disk', edits);
  editor.pushUndoStop();
}

/**
 * Hover, Ctrl+click to the definition and F2 rename in a TypeScript or JavaScript file, answered by the project's
 * language server from the editor's unsaved text. Hovers and the definitions Ctrl+mouse asks for are background
 * questions: one the user asks is never kept waiting behind them, and while one is running (`busy`) none is asked.
 * `report` says how a rename went, null to clear.
 */
export function installLanguageFeatures(
  editor: monaco.editor.ICodeEditor,
  options: {
    sessionId: string;
    file: string;
    busy: () => boolean;
    onNavigate: (location: CodeLocation) => void;
    report: (note: { text: string; failure?: boolean } | null) => void;
  }
): monaco.IDisposable {
  const { sessionId, file } = options;
  const mine = (model: monaco.editor.ITextModel): boolean => model === editor.getModel();
  const ask = (model: monaco.editor.ITextModel, query: Omit<SemanticQuery, 'file'>, priority: 'background' | 'user') =>
    invoke('files:semantic', { sessionId, priority, query: { ...query, file }, content: model.getValue(monaco.editor.EndOfLinePreference.TextDefined, true) });
  const wordRange = (model: monaco.editor.ITextModel, position: monaco.Position): monaco.Range => {
    const word = model.getWordAtPosition(position);
    return word ? new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn) : monaco.Range.fromPositions(position);
  };
  // Several definitions (overloads) go to the first: a peek would need the other files open as models.
  editor.updateOptions({ gotoLocation: { multipleDefinitions: 'goto' } });
  const parts = [
    monaco.languages.registerHoverProvider(LANGUAGES, {
      provideHover: async (model, position, token) => {
        if (!mine(model) || options.busy()) return null;
        // Nothing shows on a failure (an untrusted project, a hover dropped for the user's question); the buttons below say why.
        const result = await ask(model, { action: 'hover', line: position.lineNumber, column: position.column }, 'background').catch(() => null);
        if (!result?.hover || token.isCancellationRequested) return null;
        return { contents: [{ value: result.hover }], range: wordRange(model, position) };
      }
    }),
    monaco.languages.registerDefinitionProvider(LANGUAGES, {
      provideDefinition: async (model, position, token) => {
        if (!mine(model)) return null;
        const result = await ask(model, { action: 'definition', line: position.lineNumber, column: position.column }, 'background').catch(() => null);
        if (!result || token.isCancellationRequested) return null;
        return (result.locations ?? []).map((at) => ({
          uri: at.file === file ? model.uri : monaco.Uri.from({ scheme: OTHER_FILE, path: `/${at.file}` }),
          range: new monaco.Range(at.line, at.column, at.line, at.column)
        }));
      }
    }),
    monaco.editor.registerEditorOpener({
      openCodeEditor: (source, resource, at) => {
        if (source !== editor || resource.scheme !== OTHER_FILE) return false;
        const position = !at ? { lineNumber: 1, column: 1 } : 'lineNumber' in at ? at : { lineNumber: at.startLineNumber, column: at.startColumn };
        options.onNavigate({ file: resource.path.slice(1), line: position.lineNumber, column: position.column });
        return true;
      }
    }),
    monaco.languages.registerRenameProvider(LANGUAGES, {
      // The name as the server sees it fills the box; when it cannot be renamed, the editor says why at the cursor.
      resolveRenameLocation: async (model, position) => {
        if (!mine(model)) return undefined;
        try {
          const { span } = await ask(model, { action: 'rename', line: position.lineNumber, column: position.column }, 'user');
          if (span) return { range: new monaco.Range(span.line, span.column, span.endLine, span.endColumn), text: span.text };
          return { range: wordRange(model, position), text: '', rejectReason: 'There is no name to rename here.' };
        } catch (error) {
          return { range: wordRange(model, position), text: model.getWordAtPosition(position)?.word ?? '', rejectReason: errorText(error) };
        }
      },
      provideRenameEdits: async (model, position, newName, token) => {
        if (!mine(model)) return undefined;
        const version = model.getVersionId();
        options.report({ text: 'Renaming…' });
        const fail = (message: string): monaco.languages.WorkspaceEdit & monaco.languages.Rejection => {
          options.report({ text: message, failure: true });
          return { edits: [], rejectReason: message };
        };
        let files: FileEdits[];
        try {
          files = (await ask(model, { action: 'rename', line: position.lineNumber, column: position.column, newName }, 'user')).edits ?? [];
        } catch (error) {
          return fail(errorText(error));
        }
        // The user typed or moved on meanwhile: nothing was changed anywhere.
        if (token.isCancellationRequested || model.getVersionId() !== version) {
          options.report(null);
          return { edits: [] };
        }
        if (!files.length) return fail('There is nothing to rename here.');
        const here = files.find((f) => f.revision === null)?.edits ?? [];
        const others = files.flatMap((f) => (f.revision === null ? [] : [{ ...f, revision: f.revision }]));
        if (others.length) {
          try {
            await invoke('files:applyEdits', { sessionId, files: others });
          } catch (error) {
            return fail(errorText(error));
          }
        }
        const edits = here.map((e) => ({ range: new monaco.Range(e.line, e.column, e.endLine, e.endColumn), text: e.text }));
        const unchanged = model.getVersionId() === version;
        // Monaco makes the edits once this returns, unless the rename was cancelled while the other files were written:
        // then this file still gets its part, as one undo step, when it is as it was.
        const returned = unchanged && !token.isCancellationRequested;
        if (unchanged && !returned) {
          model.pushStackElement();
          model.pushEditOperations([], edits, () => null);
          model.pushStackElement();
        }
        const note = !unchanged
          ? { text: `The other ${plural(others.length)} were renamed, but this file changed meanwhile. Rename it here too, or restore the others from the Changes panel.`, failure: true }
          : { text: `Renamed in ${plural(files.length)}.${others.length ? ' Ctrl+Z undoes it in this file; the Changes panel can restore the others.' : ''}` };
        // Said once the edits are in: an edit clears the note.
        setTimeout(() => options.report(note), 0);
        return returned ? { edits: edits.map((textEdit) => ({ resource: model.uri, versionId: version, textEdit })) } : { edits: [] };
      }
    })
  ];
  return { dispose: () => { for (const part of parts) part.dispose(); } };
}
