import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WandSparkles } from 'lucide-react';
import * as monaco from 'monaco-editor/editor/editor.api.js';
import { Button } from '../../components/Button';
import { errorText, invoke } from '../../lib/ipc';
import { selectionAnchor } from '../review/reviewModel';

/** Lines around the selection sent with a request; the main process cuts its window out of them. */
const LINES_BEFORE = 250;
const LINES_AFTER = 100;
/** The most Edit with AI rewrites at once, as editor:inlineEdit takes it. */
const MAX_SELECTION = 40_000;

interface BoxState {
  running: boolean;
  /** The rewrite shown as a diff. It stays while a refinement of it is written. */
  proposal: string | null;
  /** Counts the proposals that came, so the box can tell a new one. */
  made: number;
  /** How many lines the proposal replaces. */
  replaced: number;
  error: string | null;
  note: string | null;
}

interface Context {
  sessionId: string;
  file: string;
  /** Context keys for the editor's own Escape and Ctrl+Enter, when the keyboard is in the code rather than the box. */
  open: monaco.editor.IContextKey<boolean>;
  proposing: monaco.editor.IContextKey<boolean>;
  closed: () => void;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

function InlineEditBox({ state, onSubmit, onStop, onAccept, onClose }: { state: BoxState; onSubmit: (text: string) => void; onStop: () => void; onAccept: () => void; onClose: () => void }) {
  const [text, setText] = useState('');
  const [made, setMade] = useState(state.made);
  const input = useRef<HTMLTextAreaElement>(null);
  const proposing = state.proposal !== null;
  useEffect(() => input.current?.focus(), []);
  // A proposal that came takes the instruction away: what is typed next refines it.
  if (made !== state.made) {
    setMade(state.made);
    setText('');
  }
  // The box grows with what is typed, up to a few lines.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [text]);
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (proposing && !state.running) onAccept();
    } else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (!state.running && text.trim()) onSubmit(text);
    }
  };
  const added = state.proposal?.split('\n').length ?? 0;
  const status = state.running
    ? 'Writing the change…'
    : proposing
      ? `${plural(state.replaced, 'line')} become ${plural(added, 'line')}. Ctrl+Enter accepts, Escape rejects.`
      : (state.note ?? 'Enter sends, Shift+Enter starts a new line, Escape closes.');
  return (
    <div role="group" aria-label="Edit with AI" className="motion-pop flex flex-col gap-6 rounded-md border border-border bg-surface px-8 py-6 font-sans shadow-popover focus-within:border-border-strong">
      <div className="flex items-start gap-6">
        <WandSparkles className="mt-3 size-13 shrink-0 text-icon-muted" aria-hidden="true" />
        <textarea
          ref={input}
          rows={1}
          value={text}
          readOnly={state.running}
          aria-label={proposing ? 'Change the proposal' : 'Describe the change'}
          aria-busy={state.running}
          placeholder={proposing ? 'Ask for a change to the proposal' : 'Describe the change'}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          className="min-w-0 flex-1 resize-none bg-transparent text-sm text-fg outline-none placeholder:text-fg-placeholder"
        />
      </div>
      <div className="flex flex-wrap items-center gap-6">
        <p role="status" className="min-w-0 flex-1 text-2xs text-fg-muted">
          {status}
        </p>
        {state.running ? (
          <Button size="xs" variant="ghost" onClick={onStop}>
            Stop
          </Button>
        ) : null}
        {!state.running && text.trim() ? (
          <Button size="xs" variant={proposing ? 'ghost' : 'secondary'} onClick={() => onSubmit(text)}>
            Send
          </Button>
        ) : null}
        {!state.running && proposing ? (
          <>
            <Button size="xs" variant="primary" aria-keyshortcuts="Control+Enter" onClick={onAccept}>
              Accept
            </Button>
            <Button size="xs" variant="ghost" aria-keyshortcuts="Escape" onClick={onClose}>
              Reject
            </Button>
          </>
        ) : null}
      </div>
      {state.error ? (
        <p role="alert" className="text-xs text-danger">
          {state.error}
        </p>
      ) : null}
      {/* The proposal is drawn in the code, where a screen reader does not go; it is read from here. */}
      {proposing ? <pre className="sr-only">{state.proposal}</pre> : null}
    </div>
  );
}

/**
 * One Edit with AI on lines of the file: a box above them takes the instruction, the session's model writes
 * new lines, and they show as a diff (the old lines red and struck, the new ones green beneath) until they
 * are accepted, refined or rejected. Accepting changes the draft only, as one step of undo.
 */
class InlineEdit {
  private readonly node = document.createElement('div');
  private readonly root: Root;
  /** The lines the edit is about; it follows them while the file changes around them. */
  private readonly target: monaco.editor.IEditorDecorationsCollection;
  private readonly removed: monaco.editor.IEditorDecorationsCollection;
  private readonly widget: monaco.editor.IContentWidget;
  private readonly listeners: monaco.IDisposable[] = [];
  /** The room made above the lines for the box, and the zone that shows the proposed lines. */
  private room: { id: string; zone: monaco.editor.IViewZone } | null = null;
  private added: string | null = null;
  private state: BoxState = { running: false, proposal: null, made: 0, replaced: 0, error: null, note: null };
  private requestId: string | null = null;
  private applying = false;
  private closed = false;
  /** The box takes the keyboard once Monaco shows it: a widget is hidden until its first layout, and hidden things can't be focused. */
  private wantsFocus = true;

  constructor(
    private readonly editor: monaco.editor.IStandaloneCodeEditor,
    private readonly model: monaco.editor.ITextModel,
    lines: { start: number; end: number },
    private readonly context: Context
  ) {
    this.target = editor.createDecorationsCollection([
      {
        range: new monaco.Range(lines.start, 1, lines.end, model.getLineMaxColumn(lines.end)),
        options: { isWholeLine: true, className: 'graft-ai-target', stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges }
      }
    ]);
    this.removed = editor.createDecorationsCollection();
    // The box's keys and clicks are its own: the editor around it would take Enter, Escape or a click for the code.
    for (const type of ['keydown', 'pointerdown', 'mousedown'] as const) this.node.addEventListener(type, (event) => event.stopPropagation());
    this.root = createRoot(this.node);
    this.widget = {
      getId: () => 'graft.inlineEdit',
      getDomNode: () => this.node,
      getPosition: () => {
        const range = this.target.getRange(0);
        return range ? { position: { lineNumber: range.startLineNumber, column: 1 }, preference: [monaco.editor.ContentWidgetPositionPreference.ABOVE] } : null;
      },
      afterRender: (position) => {
        if (position !== null && this.wantsFocus) this.wantsFocus = !this.focus();
      }
    };
    this.width();
    editor.revealLinesInCenterIfOutsideViewport(lines.start, lines.end);
    editor.addContentWidget(this.widget);
    const resize = new ResizeObserver(() => this.fit());
    resize.observe(this.node);
    this.listeners.push({ dispose: () => resize.disconnect() }, editor.onDidLayoutChange(() => this.width()), model.onDidChangeContent(() => this.changed()));
    context.open.set(true);
    this.render();
  }

  /** Puts the keyboard in the box; false when the box can't take it yet. */
  focus(): boolean {
    const input = this.node.querySelector('textarea');
    input?.focus();
    return input !== null && document.activeElement === input;
  }

  accept(): void {
    const range = this.lines();
    const replacement = this.state.proposal;
    if (!range || replacement === null || this.state.running) return;
    const { editor, model } = this;
    this.applying = true;
    try {
      // A step of its own on the undo stack: one Ctrl+Z takes the whole edit back.
      model.pushStackElement();
      model.pushEditOperations(editor.getSelections(), [{ range, text: replacement.replace(/\n/g, model.getEOL()) }], () => null);
      model.pushStackElement();
    } finally {
      this.applying = false;
    }
    const last = range.startLineNumber + replacement.split('\n').length - 1;
    this.close();
    editor.setPosition({ lineNumber: last, column: model.getLineMaxColumn(last) });
  }

  close(focus = true): void {
    if (this.closed) return;
    this.cancelRequest();
    this.clearDiff();
    this.closed = true;
    this.target.clear();
    const room = this.room;
    if (room) this.editor.changeViewZones((zones) => zones.removeZone(room.id));
    this.editor.removeContentWidget(this.widget);
    for (const listener of this.listeners) listener.dispose();
    // Later, not inside the box's own key or click handler, where React is still at work.
    setTimeout(() => this.root.unmount(), 0);
    this.context.open.set(false);
    this.context.closed();
    if (focus) this.editor.focus();
  }

  private async submit(instruction: string): Promise<void> {
    const range = this.lines();
    if (!range || this.state.running || !instruction.trim()) return;
    const { model } = this;
    const lf = monaco.editor.EndOfLinePreference.LF;
    const start = range.startLineNumber;
    const end = range.endLineNumber;
    const selection = model.getValueInRange(range, lf);
    if (selection.length > MAX_SELECTION) {
      this.set({ error: 'Select fewer lines: Edit with AI changes up to 40,000 characters at a time.' });
      return;
    }
    const top = Math.max(1, start - LINES_BEFORE);
    const bottom = Math.min(model.getLineCount(), end + LINES_AFTER);
    const before = start > 1 ? model.getValueInRange(new monaco.Range(top, 1, start - 1, model.getLineMaxColumn(start - 1)), lf).slice(-20_000) : '';
    const after = end < bottom ? model.getValueInRange(new monaco.Range(end + 1, 1, bottom, model.getLineMaxColumn(bottom)), lf).slice(0, 10_000) : '';
    const requestId = crypto.randomUUID();
    this.requestId = requestId;
    this.set({ running: true, error: null, note: null });
    try {
      const { replacement } = await invoke('editor:inlineEdit', {
        sessionId: this.context.sessionId,
        requestId,
        file: this.context.file,
        language: model.getLanguageId(),
        before,
        selection,
        after,
        instruction: instruction.trim(),
        ...(this.state.proposal === null ? {} : { proposal: this.state.proposal })
      });
      if (this.requestId !== requestId || this.closed) return;
      this.requestId = null;
      if (replacement === (this.state.proposal ?? selection)) this.set({ running: false, note: 'The model proposed no change. Say it another way.' });
      else this.show(replacement, start, end);
    } catch (error) {
      if (this.requestId !== requestId || this.closed) return;
      this.requestId = null;
      this.set({ running: false, error: errorText(error) });
    }
  }

  private stop(): void {
    if (!this.cancelRequest()) return;
    this.set({ running: false, note: 'Stopped. Enter asks again.' });
  }

  /** The proposal as a diff: the lines it replaces red and struck, its own lines green beneath them. */
  private show(replacement: string, start: number, end: number): void {
    const { editor, model } = this;
    this.clearDiff();
    const replaced = new monaco.Range(start, 1, end, model.getLineMaxColumn(end));
    if (model.getValueInRange(replaced).trim()) {
      this.removed.set([{ range: replaced, options: { isWholeLine: true, className: 'graft-ai-removed', inlineClassName: 'graft-ai-removed-text' } }]);
    }
    const font = editor.getOption(monaco.editor.EditorOption.fontInfo) as monaco.editor.FontInfo;
    const node = document.createElement('div');
    node.className = 'graft-ai-added';
    Object.assign(node.style, { fontFamily: font.fontFamily, fontSize: `${font.fontSize}px`, lineHeight: `${font.lineHeight}px`, tabSize: String(model.getOptions().tabSize) });
    for (const line of replacement.split('\n')) {
      const row = document.createElement('div');
      // An empty line keeps its height.
      row.textContent = line || '\u200b';
      node.append(row);
    }
    // As tall as its lines are once they wrap at the editor's width.
    const layout = editor.getLayoutInfo();
    Object.assign(node.style, { position: 'absolute', visibility: 'hidden', width: `${layout.contentWidth - layout.verticalScrollbarWidth}px` });
    editor.getDomNode()?.append(node);
    const height = Math.max(node.offsetHeight, font.lineHeight);
    node.remove();
    for (const property of ['position', 'visibility', 'width']) node.style.removeProperty(property);
    editor.changeViewZones((zones) => {
      this.added = zones.addZone({ afterLineNumber: end, heightInPx: height, domNode: node });
    });
    this.context.proposing.set(true);
    this.set({ running: false, proposal: replacement, made: this.state.made + 1, replaced: end - start + 1, error: null, note: null });
    editor.revealLinesInCenterIfOutsideViewport(start, end + 1);
  }

  private clearDiff(): void {
    this.removed.clear();
    const added = this.added;
    if (added !== null) this.editor.changeViewZones((zones) => zones.removeZone(added));
    this.added = null;
    this.context.proposing.set(false);
  }

  /** Someone typed in the file: a proposal for the lines as they were is dropped, and so is one being written. */
  private changed(): void {
    if (this.applying || this.closed || (!this.state.running && this.state.proposal === null)) return;
    this.cancelRequest();
    this.clearDiff();
    this.set({ running: false, proposal: null, note: 'The code changed, so the proposal was dropped. Ask again when you are ready.' });
  }

  /** Ends the request being written, if there is one; true when there was. */
  private cancelRequest(): boolean {
    const requestId = this.requestId;
    if (!requestId) return false;
    this.requestId = null;
    void invoke('editor:cancel', { requestId }).catch(() => undefined);
    return true;
  }

  /** The whole lines the edit is about, as they are now. */
  private lines(): monaco.Range | null {
    const range = this.target.getRange(0);
    return range ? new monaco.Range(range.startLineNumber, 1, range.endLineNumber, this.model.getLineMaxColumn(range.endLineNumber)) : null;
  }

  private width(): void {
    const layout = this.editor.getLayoutInfo();
    this.node.style.width = `${Math.max(220, Math.min(560, layout.contentWidth - layout.verticalScrollbarWidth - 24))}px`;
  }

  /** Makes room above the lines for the box, as tall as the box is now, and keeps the box in view when it opens. */
  private fit(): void {
    const range = this.target.getRange(0);
    if (this.closed || !range) return;
    const height = this.node.offsetHeight + 6;
    let opened = false;
    this.editor.changeViewZones((zones) => {
      if (!this.room) {
        const zone: monaco.editor.IViewZone = { afterLineNumber: range.startLineNumber - 1, heightInPx: height, domNode: document.createElement('div') };
        this.room = { id: zones.addZone(zone), zone };
        opened = true;
      } else if (this.room.zone.heightInPx !== height) {
        this.room.zone.heightInPx = height;
        zones.layoutZone(this.room.id);
      }
    });
    this.editor.layoutContentWidget(this.widget);
    const top = this.editor.getTopForLineNumber(range.startLineNumber, true);
    if (opened && this.editor.getScrollTop() > top) this.editor.setScrollTop(top);
  }

  private set(patch: Partial<BoxState>): void {
    this.state = { ...this.state, ...patch };
    this.render();
  }

  private render(): void {
    if (this.closed) return;
    this.root.render(<InlineEditBox state={this.state} onSubmit={(text) => void this.submit(text)} onStop={() => this.stop()} onAccept={() => this.accept()} onClose={() => this.close()} />);
  }
}

/**
 * Edit with AI on an editor: Ctrl+I (or the action run from the toolbar) opens the box on the selected lines,
 * or the cursor's line. While a proposal shows, Ctrl+Enter accepts it and Escape rejects it from the code too.
 */
export function installInlineEdit(editor: monaco.editor.IStandaloneCodeEditor, options: { sessionId: string; file: string }): monaco.IDisposable {
  let current: InlineEdit | null = null;
  const context: Context = {
    ...options,
    open: editor.createContextKey('graftInlineEdit', false),
    proposing: editor.createContextKey('graftInlineEditProposal', false),
    closed: () => {
      current = null;
    }
  };
  const start = (): void => {
    const model = editor.getModel();
    const selection = editor.getSelection();
    if (current) current.focus();
    else if (model && selection) {
      const at = selectionAnchor({ startLine: selection.startLineNumber, endLine: selection.endLineNumber, endColumn: selection.endColumn }, (line) => model.getLineContent(line));
      current = new InlineEdit(editor, model, { start: at.line, end: at.endLine }, context);
    }
  };
  const actions = [
    editor.addAction({ id: 'graft.inlineEdit', label: 'Edit with AI', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI], precondition: '!editorReadonly', run: start }),
    editor.addAction({ id: 'graft.inlineEdit.accept', label: 'Accept the proposed edit', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter], precondition: 'graftInlineEditProposal', run: () => current?.accept() }),
    editor.addAction({ id: 'graft.inlineEdit.close', label: 'Close Edit with AI', keybindings: [monaco.KeyCode.Escape], precondition: 'graftInlineEdit', run: () => current?.close() })
  ];
  return {
    dispose: () => {
      current?.close(false);
      for (const action of actions) action.dispose();
    }
  };
}
