import * as RD from '@radix-ui/react-dialog';
import { useId, useMemo, useState, type KeyboardEvent } from 'react';
import { Check, ChevronRight } from 'lucide-react';
import { Kbd } from '../../components/Badge';
import { cn } from '../../lib/cn';
import { fuzzyFilter } from '../../lib/fuzzy';
import { usePresence } from '../../lib/motion';
import { shortcutText } from '../../lib/shortcuts';
import { useApp } from '../../stores/app';
import { useNav } from '../../stores/nav';
import { useSessions } from '../../stores/sessions';
import { reportError } from '../../stores/toasts';
import { useUi } from '../../stores/ui';
import { lastTypedMessage } from '../session/sessionControls';
import { paletteCommands, type PaletteCommand } from './paletteCommands';
import { highlight } from './SearchDialog';

const RECENT_KEY = 'graft.palette.recent';
const RECENT_MAX = 5;

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

/** Palette contents; mounted only while open, so each opening starts fresh. */
function PalettePanel() {
  const initial = useUi((s) => s.paletteQuery);
  const [query, setQuery] = useState(initial);
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

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    const count = results.length;
    if (count === 0) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      move((activeIndex + (event.key === 'ArrowDown' ? 1 : count - 1)) % count);
    } else if (event.key === 'PageDown' || event.key === 'PageUp') {
      event.preventDefault();
      move(Math.min(count - 1, Math.max(0, activeIndex + (event.key === 'PageDown' ? 8 : -8))));
    } else if (event.key === 'Enter') {
      const command = results[activeIndex];
      if (command) {
        event.preventDefault();
        run(command);
      }
    }
  };

  return (
    <>
      <div className="flex items-center gap-8 border-b border-border px-14">
        <ChevronRight className="size-16 shrink-0 text-accent" aria-hidden="true" />
        <input
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={results.length > 0 ? `${listId}-${activeIndex}` : undefined}
          aria-label="Command"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Type a command: new chat, theme, export, settings…"
          spellCheck={false}
          className="h-44 min-w-0 flex-1 bg-transparent text-md text-fg outline-none"
        />
      </div>
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
      <div className="flex h-30 shrink-0 items-center gap-14 border-t border-border-subtle px-14 text-xs text-fg-faint">
        <span className="flex items-center gap-4">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> to move
        </span>
        <span className="flex items-center gap-4">
          <Kbd>Enter</Kbd> to run
        </span>
        <span className="flex items-center gap-4">
          <Kbd>Esc</Kbd> to close
        </span>
      </div>
    </>
  );
}

/** Ctrl+Shift+P (or ">" in search): every command in the app, searchable. */
export function CommandPalette() {
  const isOpen = useUi((s) => s.paletteOpen);
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
          <RD.Description className="sr-only">Search for a command and press Enter to run it.</RD.Description>
          {present ? <PalettePanel /> : null}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
