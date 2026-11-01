import { forwardRef, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { IDisposable, IMarker, Terminal } from '@xterm/xterm';
import { CircleAlert, Copy, MessageCircleQuestion, MessageSquarePlus, SquareTerminal, WandSparkles, X } from 'lucide-react';
import type { TerminalInfoView } from '@shared/schemas/panels';
import { parseMark } from '@shared/terminalMarks';
import { Button, IconButton } from '../../components/Button';
import { Spinner } from '../../components/ContextRing';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '../../components/Menu';
import { errorText, invoke } from '../../lib/ipc';
import { logError } from '../../lib/log';
import { displayAccelerator, matchesAccelerator } from '../../lib/shortcuts';
import { useAsides } from '../../stores/asides';
import { notify, reportError } from '../../stores/toasts';
import { useUi } from '../../stores/ui';
import { BlockTracker, commandAttachment, explainQuestion, failed, outputTail, selectionAttachment, TAIL_LINES, type FailedCommand, type Screen, type Spot } from './terminalModel';

/**
 * The Terminal panel's AI: the commands the shell marks are kept (terminalModel.ts), one that fails gets a mark at
 * its prompt and a chip with Explain, Fix and Add to message, and Ctrl+K opens a bar that writes a command from
 * words. A command from the model is typed at the prompt and never run: the user presses Enter.
 */

/** Ctrl+K in the terminal writes a command; Ctrl+. reaches the actions of a failed one. Fixed keys, as the shell's own. */
export const ASK_KEYS = 'Ctrl+K';
const ACTION_KEYS = 'Ctrl+.';

/** The text between two places in xterm's buffer; a place whose line scrolled away reads from the top. */
function readText(term: Terminal, from: Spot<IMarker>, to: Spot<IMarker>, lines?: number): string {
  if (to.line.isDisposed) return '';
  const buffer = term.buffer.normal;
  const last = to.line.line;
  const top = from.line.isDisposed ? 0 : from.line.line;
  const first = lines === undefined ? top : Math.max(top, last - lines + 1);
  const out: string[] = [];
  for (let y = first; y <= last; y++) {
    const line = buffer.getLine(y);
    if (!line) break;
    // A line that goes on in the next (wrapped) keeps its last spaces: they are part of the command.
    const trim = y === last || !(buffer.getLine(y + 1)?.isWrapped ?? false);
    const text = line.translateToString(trim, y === top && !from.line.isDisposed ? from.col : 0, y === last ? to.col : undefined);
    if (out.length > 0 && line.isWrapped) out[out.length - 1] += text;
    else out.push(text);
  }
  return out.join('\n');
}

/**
 * Reads the shell's marks in a terminal view and keeps its commands. A failed one gets a red mark beside its prompt
 * line that shows its actions when clicked. `started` says a new command is running, so the last chip is stale;
 * `gone` that a failed command's lines were cleared or scrolled out of the scrollback.
 */
export function trackCommands(term: Terminal, on: { failed(command: FailedCommand): void; started(): void; gone(command: FailedCommand): void }): IDisposable {
  const screen: Screen<IMarker> = {
    here: () => ({ line: term.registerMarker(0), col: term.buffer.active.cursorX }),
    text: (from, to, lines) => readText(term, from, to, lines),
    release: (spot) => spot.line.dispose()
  };
  const tracker = new BlockTracker(screen, (block) => {
    if (!failed(block)) return;
    const command: FailedCommand = { id: block.id, command: block.command, exitCode: block.exitCode, cwd: block.cwd, output: () => screen.text(block.output.from, block.output.to, TAIL_LINES) };
    const mark = term.registerDecoration({ marker: block.start.line });
    mark?.onRender((element) => {
      // Beside the prompt, in the padding left of the first column, so no character is covered.
      element.classList.add('rounded-full', 'bg-danger', 'cursor-pointer');
      element.style.width = '4px';
      element.style.marginLeft = '-5px';
      element.title = `${block.command} failed${block.exitCode === null ? '' : ` with exit code ${String(block.exitCode)}`}. Click, or press ${displayAccelerator(ACTION_KEYS)} in the terminal, for Explain, Fix and Add to message.`;
      element.setAttribute('aria-hidden', 'true');
      element.onclick = () => on.failed(command);
    });
    block.start.line.onDispose(() => on.gone(command));
    on.failed(command);
  });
  const handlers = [133, 7].map((ident) =>
    term.parser.registerOscHandler(ident, (payload) => {
      const mark = parseMark(ident, payload);
      if (!mark) return false;
      if (mark.kind === 'output') on.started();
      tracker.mark(mark);
      return true;
    })
  );
  return { dispose: () => handlers.forEach((handler) => handler.dispose()) };
}

/** What a key pressed in the terminal is for, when it is one of the panel's own; anything else goes to the shell. */
export function terminalKey(event: globalThis.KeyboardEvent): 'ask' | 'actions' | null {
  if (matchesAccelerator(event, ASK_KEYS)) return 'ask';
  return matchesAccelerator(event, ACTION_KEYS) ? 'actions' : null;
}

/** A bar of the panel's: over the top of the terminal, closed with Escape. */
function Bar({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };
  return (
    <div
      role="group"
      aria-label={label}
      onKeyDown={onKeyDown}
      className="motion-menu-down absolute top-8 right-12 left-12 z-[var(--g-z-sticky)] flex flex-col gap-4 rounded-md border border-border bg-surface px-8 py-6 font-sans shadow-popover focus-within:border-border-strong"
    >
      {children}
    </div>
  );
}

function cancelSuggest(askId: string | null): void {
  if (askId) invoke('pty:cancelSuggest', { askId }).catch((cause: unknown) => logError('Could not stop the command request', cause));
}

/** One request to pty:suggest at a time; Stop (or closing) cancels it and an answer that comes later is dropped. */
function useSuggest(sessionId: string, terminalId: string, onTyped: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef<string | null>(null);
  const stop = (): void => {
    cancelSuggest(asked.current);
    asked.current = null;
    setBusy(false);
  };
  useEffect(() => () => cancelSuggest(asked.current), []);
  const ask = (input: { request: string; failed?: { command: string; exitCode: number | null; output: string } }): void => {
    const askId = crypto.randomUUID();
    asked.current = askId;
    setBusy(true);
    setError(null);
    invoke('pty:suggest', { sessionId, terminalId, askId, ...input })
      // Typed at the prompt without a line break: the user reads it and presses Enter.
      .then(({ command }) => (asked.current === askId ? invoke('pty:write', { id: terminalId, data: command }).then(() => true) : false))
      .then(
        (typed) => {
          if (asked.current !== askId) return;
          asked.current = null;
          setBusy(false);
          if (typed) onTyped();
        },
        (cause: unknown) => {
          if (asked.current !== askId) return;
          asked.current = null;
          setBusy(false);
          setError(errorText(cause));
        }
      );
  };
  return { busy, error, ask, stop };
}

/** Ctrl+K: words in, one command line typed at the prompt. */
export function CommandBar({ sessionId, terminalId, onClose }: { sessionId: string; terminalId: string; onClose: () => void }) {
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const suggest = useSuggest(sessionId, terminalId, onClose);
  useEffect(() => input.current?.focus(), []);
  const close = (): void => {
    suggest.stop();
    onClose();
  };
  // Stop goes away as it is pressed: the keyboard goes back to the box.
  const stop = (): void => {
    suggest.stop();
    input.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (!suggest.busy && text.trim()) suggest.ask({ request: text.trim() });
  };
  return (
    <Bar label="Write a command" onClose={close}>
      <div className="flex items-center gap-6">
        <SquareTerminal className="size-13 shrink-0 text-icon-muted" aria-hidden="true" />
        <input
          ref={input}
          type="text"
          value={text}
          readOnly={suggest.busy}
          maxLength={2_000}
          aria-label="Describe a command"
          aria-busy={suggest.busy}
          placeholder="Describe a command"
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          className="h-24 min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-placeholder"
        />
        {suggest.busy ? (
          <>
            <Spinner size={12} label="Writing the command" />
            <Button size="xs" variant="ghost" onClick={stop}>
              Stop
            </Button>
          </>
        ) : null}
        <IconButton label="Close" shortcut="Esc" size="xs" onClick={close}>
          <X className="size-14" />
        </IconButton>
      </div>
      {suggest.error ? (
        <p role="alert" className="pl-19 text-xs text-danger">
          {suggest.error}
        </p>
      ) : (
        <p role="status" className="pl-19 text-2xs text-fg-muted">
          {suggest.busy ? 'Writing the command…' : 'Enter writes it at the prompt; nothing runs until you press Enter there.'}
        </p>
      )}
    </Bar>
  );
}

/** The actions of a failed command, over the terminal until the next command starts or it is closed. */
export const FailedChip = forwardRef<HTMLDivElement, { sessionId: string; terminal: TerminalInfoView; command: FailedCommand; onClose: () => void }>(function FailedChip(
  { sessionId, terminal, command, onClose },
  ref
) {
  const suggest = useSuggest(sessionId, terminal.id, onClose);
  const close = (): void => {
    suggest.stop();
    onClose();
  };
  const ended = command.exitCode === null ? 'failed' : `failed with exit code ${String(command.exitCode)}`;
  const explain = (): void => useAsides.getState().ask(sessionId, explainQuestion(command, command.output(), terminal.title, window.graft.platform));
  // The tail only: 80 rows of a very wide terminal would pass what the channel accepts.
  const fix = (): void => suggest.ask({ request: '', failed: { command: command.command, exitCode: command.exitCode, output: outputTail(command.output()) } });
  const add = (): void => {
    useUi.getState().sendToComposer(sessionId, { files: [commandAttachment(command, command.output())] });
    notify('The command and its output added to your message');
  };
  return (
    <Bar label={`${command.command} ${ended}`} onClose={close}>
      {/* In a narrow panel the actions go below, so the command and how it ended stay readable. */}
      <div ref={ref} className="flex flex-wrap items-center justify-end gap-x-6 gap-y-4">
        <p className="flex min-w-[160px] flex-1 items-center gap-6 text-sm text-fg" title={`${command.command} ${ended}`}>
          <CircleAlert className="size-13 shrink-0 text-danger" aria-hidden="true" />
          <span className="min-w-0 truncate">
            <code className="font-mono">{command.command}</code> <span className="text-fg-muted">{ended}</span>
          </span>
        </p>
        <div className="flex items-center gap-6">
          {suggest.busy ? (
            <Spinner size={12} label="Writing a fix" />
          ) : (
            <Button size="xs" variant="ghost" leading={<MessageCircleQuestion className="size-12" />} onClick={explain}>
              Explain
            </Button>
          )}
          {/* Fix turns into Stop in the same place while the fix is written, so the keyboard stays on it. */}
          <Button size="xs" variant="ghost" leading={suggest.busy ? undefined : <WandSparkles className="size-12" />} onClick={suggest.busy ? suggest.stop : fix}>
            {suggest.busy ? 'Stop' : 'Fix'}
          </Button>
          {suggest.busy ? null : (
            <Button size="xs" variant="ghost" leading={<MessageSquarePlus className="size-12" />} onClick={add}>
              Add to message
            </Button>
          )}
          <IconButton label="Close" shortcut="Esc" size="xs" onClick={close}>
            <X className="size-14" />
          </IconButton>
        </div>
      </div>
      {suggest.error ? (
        <p role="alert" className="pl-19 text-xs text-danger">
          {suggest.error}
        </p>
      ) : suggest.busy ? (
        <p role="status" className="pl-19 text-2xs text-fg-muted">
          Writing a fix; it is typed at the prompt for you to run.
        </p>
      ) : null}
    </Bar>
  );
});

/** Right-click on the terminal: copy the selection, or add it to the message. */
export function TerminalMenu({ sessionId, term, children }: { sessionId: string; term: () => Terminal | null; children: ReactNode }) {
  const [selection, setSelection] = useState('');
  const copy = (): void => {
    navigator.clipboard.writeText(selection).catch((cause: unknown) => reportError("Couldn't copy to the clipboard", cause));
  };
  const add = (): void => {
    useUi.getState().sendToComposer(sessionId, { files: [selectionAttachment(selection)] });
    notify('The selection added to your message');
  };
  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (open) setSelection(term()?.getSelection() ?? '');
      }}
    >
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-[200px]">
        <ContextMenuItem icon={<Copy className="size-14" />} disabled={selection.length === 0} onSelect={copy}>
          Copy
        </ContextMenuItem>
        <ContextMenuItem icon={<MessageSquarePlus className="size-14" />} disabled={selection.trim().length === 0} onSelect={add}>
          Add to message
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
