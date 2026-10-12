import * as RD from '@radix-ui/react-dialog';
import { useEffect, useId, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { AtSign, Braces, Check, ChevronRight, File, FileSearch } from 'lucide-react';
import { symbolKind } from '@shared/symbolKinds';
import { Kbd } from '../../components/Badge';
import { cn } from '../../lib/cn';
import { fuzzyFilter } from '../../lib/fuzzy';
import { errorText, invoke, RequestError } from '../../lib/ipc';
import { logError } from '../../lib/log';
import { usePresence } from '../../lib/motion';
import { shortcutText } from '../../lib/shortcuts';
import { useApp } from '../../stores/app';
import { useNav } from '../../stores/nav';
import { usePanels } from '../../stores/panels';
import { useSessions } from '../../stores/sessions';
import { reportError } from '../../stores/toasts';
import { useUi } from '../../stores/ui';
import { loadWorkspaceLayout } from '../panels/workspaceLayout';
import { lastTypedMessage } from '../session/sessionControls';
import { paletteCommands, type PaletteCommand } from './paletteCommands';
import { anchorFile, fileQuery, fileRow, latestOnly, paletteInput, symbolMessage, type PaletteMode } from './paletteModel';
import { highlight } from './SearchDialog';

const RECENT_KEY = 'graft.palette.recent';
const RECENT_MAX = 5;
/** How long after the last key a file search, and a symbol search, is asked for. */
const FILES_AFTER_MS = 80;
const SYMBOLS_AFTER_MS = 250;
/** A symbol search starts from this many characters: one letter matches half a project. */
const SYMBOL_MIN = 2;

function readRecent(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function remember(id: string): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...readRecent().filter((x) => x !== id)].slice(0, RECENT_MAX)));
  } catch {
    // rocky: recent commands are a convenience; without storage the list just stays empty.
  }
}

function run(command: PaletteCommand): void {
  remember(command.id);
  useUi.getState().setPaletteOpen(false);
  // After the palette closes, so a command that opens a dialog gets the focus.
  setTimeout(() => {
    Promise.resolve()
      .then(() => command.run())
      .catch((error: unknown) => reportError(`Couldn't run “${command.title}”`, error));
  }, 0);
}

/** What a palette is typed into: the mark of its mode, and the box. */
function PaletteInput({ icon, label, placeholder, listId, activeId, query, onQuery, onKeyDown }: { icon: ReactNode; label: string; placeholder: string; listId: string; activeId: string | undefined; query: string; onQuery: (typed: string) => void; onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void }) {
  return (
    <div className="flex items-center gap-8 border-b border-border px-14">
      {icon}
      <input
        autoFocus
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={activeId}
        aria-label={label}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        spellCheck={false}
        className="h-44 min-w-0 flex-1 bg-transparent text-md text-fg outline-none"
      />
    </div>
  );
}

function PaletteFooter({ enter }: { enter: string }) {
  return (
    <div className="flex h-30 shrink-0 items-center gap-14 border-t border-border-subtle px-14 text-xs text-fg-faint">
      <span className="flex items-center gap-4">
        <Kbd>↑</Kbd>
        <Kbd>↓</Kbd> to move
      </span>
      <span className="flex items-center gap-4">
        <Kbd>Enter</Kbd> {enter}
      </span>
      <span className="flex items-center gap-4">
        <Kbd>Esc</Kbd> to close
      </span>
    </div>
  );
}

/** The keys that move through a palette's list and pick from it. */
function listKeys(count: number, active: number, move: (next: number) => void, pick: (index: number) => void): (event: KeyboardEvent<HTMLInputElement>) => void {
  return (event) => {
    if (count === 0) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      move((active + (event.key === 'ArrowDown' ? 1 : count - 1)) % count);
    } else if (event.key === 'PageDown' || event.key === 'PageUp') {
      event.preventDefault();
      move(Math.min(count - 1, Math.max(0, active + (event.key === 'PageDown' ? 8 : -8))));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      pick(active);
    }
  };
}

/** Every command in the app, searchable; with nothing typed, the recent ones first. */
function CommandsPanel({ query, onQuery }: { query: string; onQuery: (typed: string) => void }) {
  const [active, setActive] = useState(0);
  const listId = useId();
  const route = useNav((s) => s.route);
  const sessionId = route.name === 'session' ? route.id : null;
  const session = useSessions((s) => (sessionId ? (s.summaries[sessionId] ?? null) : null));
  const view = useSessions((s) => (sessionId ? s.views[sessionId] : undefined));
  const settings = useApp((s) => s.settings);
  const [recent] = useState(readRecent);

  const commands = useMemo(
    () =>
      paletteCommands({
        route,
        session,
        turnActive: view?.turnActive ?? false,
        lastUserMessageId: view ? (lastTypedMessage(view.messages)?.id ?? null) : null,
        settings
      }),
    [route, session, view, settings]
  );

  const searching = query.trim().length > 0;
  const results = useMemo(() => {
    if (searching) return fuzzyFilter(commands, query, (c) => `${c.title} ${c.keywords ?? ''} ${c.group}`);
    const byId = new Map(commands.map((c) => [c.id, c]));
    const first = recent.flatMap((id) => {
      const c = byId.get(id);
      return c ? [{ ...c, group: 'Recent' }] : [];
    });
    return [...first, ...commands.filter((c) => !recent.includes(c.id))];
  }, [commands, query, recent, searching]);
  const activeIndex = Math.min(active, Math.max(0, results.length - 1));

  const move = (next: number): void => {
    setActive(next);
    document.getElementById(`${listId}-${next}`)?.scrollIntoView({ block: 'nearest' });
  };
  const pick = (index: number): void => {
    const command = results[index];
    if (command) run(command);
  };

  return (
    <>
      <PaletteInput
        icon={<ChevronRight className="size-16 shrink-0 text-accent" aria-hidden="true" />}
        label="Command"
        placeholder="Type a command: new chat, theme, export, settings…"
        listId={listId}
        activeId={results.length > 0 ? `${listId}-${activeIndex}` : undefined}
        query={query}
        onQuery={(typed) => {
          onQuery(typed);
          setActive(0);
        }}
        onKeyDown={listKeys(results.length, activeIndex, move, pick)}
      />
      <div id={listId} role="listbox" aria-label="Commands" className="min-h-0 flex-1 overflow-y-auto p-4">
        {results.length === 0 ? <p className="px-8 py-12 text-base text-fg-muted">No command matches “{query.trim()}”.</p> : null}
        {results.map((command, i) => {
          const Icon = command.icon;
          const header = !searching && command.group !== results[i - 1]?.group;
          return (
            <div key={`${command.group}:${command.id}`}>
              {header ? <p className="px-8 pt-8 pb-2 text-xs font-medium tracking-wide text-fg-faint uppercase">{command.group}</p> : null}
              <div
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === activeIndex}
                onMouseMove={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => run(command)}
                className={cn('flex h-32 cursor-default items-center gap-10 rounded-md px-8', i === activeIndex && 'bg-hover')}
              >
                {Icon ? <Icon className="size-14 shrink-0 text-icon-muted" /> : <span className="size-14 shrink-0" />}
                <span className="min-w-0 flex-1 truncate text-base text-fg">{highlight(command.title, query)}</span>
                {command.checked ? <Check className="size-14 shrink-0 text-accent" aria-label="Current" /> : null}
                {searching ? <span className="shrink-0 text-sm text-fg-faint">{command.group}</span> : null}
                {command.shortcut ? <Kbd>{shortcutText(command.shortcut)}</Kbd> : null}
              </div>
            </div>
          );
        })}
      </div>
      <PaletteFooter enter="to run" />
    </>
  );
}

/** A row of the file and symbol palettes: what it is, what it is in, and where. */
interface PaletteRow {
  key: string;
  title: ReactNode;
  detail?: string;
  hint?: string;
}

/** What the file and the symbol palette share: the box, a list of places with its keys, and the sentence for an empty list. */
function PlacesPanel({ icon, rowIcon, label, list, placeholder, query, onQuery, rows, empty, onPick }: { icon: ReactNode; rowIcon: ReactNode; label: string; list: string; placeholder: string; query: string; onQuery: (typed: string) => void; rows: PaletteRow[]; empty: string; onPick: (index: number) => void }) {
  const [active, setActive] = useState(0);
  const listId = useId();
  const activeIndex = Math.min(active, Math.max(0, rows.length - 1));
  const move = (next: number): void => {
    setActive(next);
    document.getElementById(`${listId}-${next}`)?.scrollIntoView({ block: 'nearest' });
  };
  return (
    <>
      <PaletteInput
        icon={icon}
        label={label}
        placeholder={placeholder}
        listId={listId}
        activeId={rows.length > 0 ? `${listId}-${activeIndex}` : undefined}
        query={query}
        onQuery={(typed) => {
          onQuery(typed);
          setActive(0);
        }}
        onKeyDown={listKeys(rows.length, activeIndex, move, onPick)}
      />
      <div id={listId} role="listbox" aria-label={list} className="min-h-0 flex-1 overflow-y-auto p-4">
        {rows.length === 0 ? (
          <p role="status" className="px-8 py-12 text-base text-fg-muted">
            {empty}
          </p>
        ) : null}
        {rows.map((row, i) => (
          <div
            key={row.key}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={i === activeIndex}
            onMouseMove={() => setActive(i)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(i)}
            className={cn('flex h-32 cursor-default items-center gap-10 rounded-md px-8', i === activeIndex && 'bg-hover')}
          >
            {rowIcon}
            <span className="max-w-[60%] shrink-0 truncate text-base text-fg">{row.title}</span>
            <span className="min-w-0 flex-1 truncate text-sm text-fg-muted">{row.detail ?? ''}</span>
            {row.hint ? <span className="max-w-[45%] shrink truncate font-mono text-2xs text-fg-faint">{row.hint}</span> : null}
          </div>
        ))}
      </div>
      <PaletteFooter enter="to open" />
    </>
  );
}

/** Closes the palette and shows a file in the session's Files panel, in the editor at its place when it has one. */
function openPlace(sessionId: string, path: string, at: { line: number; column?: number } | null): void {
  useUi.getState().setPaletteOpen(false);
  usePanels.getState().openFile(sessionId, path, at);
}

/** Open a file by name: the files open in the Files panel first, then the project's; typed text is matched as "@" matches it. */
function FilesPanel({ sessionId, root, query, onQuery }: { sessionId: string; root: string; query: string; onQuery: (typed: string) => void }) {
  const { text, line } = fileQuery(query);
  const [found, setFound] = useState<{ text: string; paths: string[] } | null>(null);
  const [tabs] = useState(() => loadWorkspaceLayout(sessionId).tabs.map((tab) => tab.path));
  // An answer for an older query arrives late in a large project: only the newest is shown.
  const show = useMemo(
    () =>
      latestOnly<{ text: string; paths: string[] }>(setFound, (error) => {
        logError('The file search failed', error);
        setFound({ text: '', paths: [] });
      }),
    []
  );
  useEffect(() => {
    const timer = setTimeout(() => show(invoke('files:search', { root, query: text }).then((paths) => ({ text, paths }))), text.length === 0 ? 0 : FILES_AFTER_MS);
    return () => clearTimeout(timer);
  }, [root, text, show]);
  const paths = text.length === 0 ? [...tabs, ...(found?.paths ?? []).filter((path) => !tabs.includes(path))].slice(0, 40) : (found?.paths ?? []);
  const rows = paths.map((path): PaletteRow => {
    const { name, folder } = fileRow(path);
    return { key: path, title: highlight(name, text), detail: folder };
  });
  return (
    <PlacesPanel
      icon={<FileSearch className="size-16 shrink-0 text-accent" aria-hidden="true" />}
      rowIcon={<File className="size-14 shrink-0 text-icon-muted" aria-hidden="true" />}
      label="Open a file"
      list="Files"
      placeholder="Open a file by name…"
      query={query}
      onQuery={onQuery}
      rows={rows}
      empty={found === null ? 'Searching…' : text.length > 0 ? `No file matches "${text}".` : 'This folder has no files to open.'}
      onPick={(index) => {
        const path = paths[index];
        if (path) openPlace(sessionId, path, line === null ? null : { line });
      }}
    />
  );
}

interface FoundSymbol {
  file: string;
  line: number;
  column: number;
  name: string;
  kind: number;
  container?: string | undefined;
}

type SymbolAnswer = { name: string; symbols: FoundSymbol[] } | { name: string; failed: string; untrusted: boolean };

/** Go to a symbol by name, through the language server Graft runs for a trusted TypeScript or JavaScript project. */
function SymbolsPanel({ sessionId, root, query, onQuery }: { sessionId: string; root: string; query: string; onQuery: (typed: string) => void }) {
  const name = query.trim();
  /** The file that says which project is meant: undefined while it is looked for, null when the folder has none. */
  const [anchor, setAnchor] = useState<string | null | undefined>(undefined);
  const [answer, setAnswer] = useState<SymbolAnswer | null>(null);
  useEffect(() => {
    let cancelled = false;
    // The first files of a project may all be something else, so its TypeScript and JavaScript files are asked for by name too.
    Promise.all(['', '.ts', '.js'].map((wanted) => invoke('files:search', { root, query: wanted })))
      .then((lists) => {
        if (!cancelled) setAnchor(anchorFile(loadWorkspaceLayout(sessionId).activePath, lists.flat()));
      })
      .catch((error: unknown) => {
        logError('The file search failed', error);
        if (!cancelled) setAnchor(null);
      });
    return () => {
      cancelled = true;
    };
  }, [root, sessionId]);
  const show = useMemo(() => latestOnly<SymbolAnswer>(setAnswer), []);
  useEffect(() => {
    if (!anchor || name.length < SYMBOL_MIN) return;
    const timer = setTimeout(
      () =>
        show(
          invoke('files:semantic', { sessionId, query: { action: 'symbol', file: anchor, name } }).then(
            (result): SymbolAnswer => ({ name, symbols: result.symbols ?? [] }),
            (error: unknown): SymbolAnswer => ({ name, failed: errorText(error), untrusted: error instanceof RequestError && error.code === 'project_untrusted' })
          )
        ),
      SYMBOLS_AFTER_MS
    );
    return () => clearTimeout(timer);
  }, [anchor, name, sessionId, show]);

  const current = answer?.name === name ? answer : null;
  const symbols = current && 'symbols' in current ? current.symbols : [];
  const empty =
    anchor === null
      ? symbolMessage('no-files', name)
      : current && 'failed' in current
        ? current.untrusted
          ? symbolMessage('untrusted', name)
          : current.failed
        : name.length < SYMBOL_MIN
          ? 'Type two letters of a name or more.'
          : current
            ? symbolMessage('none', name)
            : symbolMessage('searching', name);
  const rows = symbols.map(
    (symbol, i): PaletteRow => ({
      key: `${symbol.file}:${String(symbol.line)}:${String(symbol.column)}:${String(i)}`,
      title: highlight(symbol.name, name),
      detail: `${symbolKind(symbol.kind)}${symbol.container ? ` in ${symbol.container}` : ''}`,
      hint: `${symbol.file}:${String(symbol.line)}`
    })
  );
  return (
    <PlacesPanel
      icon={<AtSign className="size-16 shrink-0 text-accent" aria-hidden="true" />}
      rowIcon={<Braces className="size-14 shrink-0 text-icon-muted" aria-hidden="true" />}
      label="Go to a symbol"
      list="Symbols"
      placeholder="Go to a symbol by name…"
      query={query}
      onQuery={onQuery}
      rows={rows}
      empty={empty}
      onPick={(index) => {
        const symbol = symbols[index];
        if (symbol) openPlace(sessionId, symbol.file, { line: symbol.line, column: symbol.column });
      }}
    />
  );
}

/**
 * What the palette holds; mounted only while it is open, so each opening
 * starts fresh. A file and a symbol are looked for in the code session on
 * screen: without one with a folder, the palette is the command palette.
 */
function PaletteBody() {
  const [state, setState] = useState<{ mode: PaletteMode; query: string }>(() => ({ mode: useUi.getState().paletteMode, query: useUi.getState().paletteQuery }));
  const route = useNav((s) => s.route);
  const sessionId = route.name === 'session' ? route.id : null;
  const session = useSessions((s) => (sessionId ? (s.summaries[sessionId] ?? null) : null));
  const root = session?.kind === 'code' ? (session.worktreePath ?? session.cwd) : null;
  // In the file palette, ">" first turns it into the command palette and "@" first into the symbol palette.
  const onQuery = (typed: string): void => setState(paletteInput(state.mode, typed));
  if (state.mode === 'commands' || session === null || root === null) return <CommandsPanel query={state.query} onQuery={onQuery} />;
  if (state.mode === 'files') return <FilesPanel sessionId={session.id} root={root} query={state.query} onQuery={onQuery} />;
  return <SymbolsPanel sessionId={session.id} root={root} query={state.query} onQuery={onQuery} />;
}

/** Ctrl+Shift+P (or ">" in search): every command in the app. Ctrl+P: a file by its name. Ctrl+T: a symbol by its name. */
export function CommandPalette() {
  const isOpen = useUi((s) => s.paletteOpen);
  const opened = useUi((s) => s.paletteOpened);
  const setOpen = useUi((s) => s.setPaletteOpen);
  // The panel stays while the palette fades out, then is dropped so each opening starts fresh.
  const present = usePresence(isOpen);
  return (
    <RD.Root open={isOpen} onOpenChange={(open) => setOpen(open)}>
      <RD.Portal>
        <RD.Overlay className="overlay-scrim fixed inset-0 z-[var(--g-z-dialog)] bg-overlay" />
        <RD.Content
          aria-label="Command palette"
          className="overlay-quick fixed top-[12vh] left-1/2 z-[var(--g-z-dialog)] flex max-h-[70vh] w-[min(640px,calc(100vw-48px))] -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-popover outline-none"
        >
          <RD.Title className="sr-only">Command palette</RD.Title>
          <RD.Description className="sr-only">Search for a command, a file or a symbol and press Enter.</RD.Description>
          {/* Opened again before it had gone (a command that opens the file palette): a new body, in the mode asked for. */}
          {present ? <PaletteBody key={opened} /> : null}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
