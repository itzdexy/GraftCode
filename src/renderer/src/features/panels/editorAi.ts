import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/editor/contrib/inlineCompletions/browser/inlineCompletions.contribution.js';
import { invoke } from '../../lib/ipc';
import { useApp } from '../../stores/app';
import { BIG_FILE, Suggestions, suggestionKey } from './editorAiModel';
import { installInlineEdit } from './inlineEdit';
import './editorAi.css';

/** Lines around the cursor sent with a request; the main process cuts its window out of them. */
const LINES_BEFORE = 250;
const LINES_AFTER = 100;

/**
 * The Files editor's AI, installed onto one editor: grey suggestions as you type (Tab accepts, Ctrl+Right
 * accepts a word, Escape dismisses) and Edit with AI (Ctrl+I). `onNote` gets the reason suggestions stopped,
 * once, and null when they work again. The disposable takes all of it away.
 */
export function installEditorAi(editor: monaco.editor.IStandaloneCodeEditor, options: { sessionId: string; file: string; onNote: (note: string | null) => void }): monaco.IDisposable {
  const { sessionId, file } = options;
  const suggestions = new Suggestions({
    cancel: (requestId) => void invoke('editor:cancel', { requestId }).catch(() => undefined),
    note: options.onNote
  });
  const provider = monaco.languages.registerInlineCompletionsProvider('*', {
    // Asked once typing pauses; Monaco cancels the token when typing goes on.
    debounceDelayMs: 300,
    provideInlineCompletions: async (model, position, _context, token) => {
      if (model !== editor.getModel() || !useApp.getState().settings?.editor.suggestions || !suggestions.ready()) return undefined;
      if (editor.getSelections()?.some((selection) => !selection.isEmpty()) || model.getValueLength() > BIG_FILE) return undefined;
      const { lineNumber, column } = position;
      const last = Math.min(model.getLineCount(), lineNumber + LINES_AFTER);
      const lf = monaco.editor.EndOfLinePreference.LF;
      const prefix = model.getValueInRange(new monaco.Range(Math.max(1, lineNumber - LINES_BEFORE), 1, lineNumber, column), lf).slice(-20_000);
      const suffix = model.getValueInRange(new monaco.Range(lineNumber, column, last, model.getLineMaxColumn(last)), lf).slice(0, 10_000);
      const ask = (requestId: string): Promise<string> =>
        invoke('editor:complete', { sessionId, requestId, file, language: model.getLanguageId(), prefix, suffix }).then((answer) => answer.text);
      const text = await suggestions.suggest(suggestionKey(file, prefix, suffix), ask, token);
      return text ? { items: [{ insertText: text, range: new monaco.Range(lineNumber, column, lineNumber, column) }] } : undefined;
    },
    disposeInlineCompletions: () => undefined
  });
  // Monaco leaves Ctrl+Right to word moves while it assumes a screen reader, which this editor always does
  // (accessibilitySupport: 'on'); taking the next word of a suggestion is bound here for it.
  const nextWord = editor.addAction({
    id: 'graft.suggestion.acceptWord',
    label: 'Accept the next word of the suggestion',
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.RightArrow],
    precondition: 'inlineSuggestionVisible && cursorBeforeGhostText && !editorReadonly',
    run: () => editor.trigger('keyboard', 'editor.action.inlineSuggest.acceptNextWord', {})
  });
  // Switched off (here or in Settings): the grey text on screen goes too.
  const unsubscribe = useApp.subscribe((state, before) => {
    if (before.settings?.editor.suggestions && !state.settings?.editor.suggestions) editor.trigger('graft', 'editor.action.inlineSuggest.hide', {});
  });
  const edit = installInlineEdit(editor, { sessionId, file });
  return {
    dispose: () => {
      provider.dispose();
      nextWord.dispose();
      unsubscribe();
      edit.dispose();
    }
  };
}
