import * as RD from '@radix-ui/react-dialog';
import { useEffect, useId, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Code, MessagesSquare, Search } from 'lucide-react';
import type { SearchResult } from '@shared/schemas/app';
import { Spinner } from '../../components/ContextRing';
import { cn } from '../../lib/cn';
import { relativeTime } from '../../lib/format';
import { errorText, invoke } from '../../lib/ipc';
import { useApp } from '../../stores/app';
import { useNav } from '../../stores/nav';
import { useSessions } from '../../stores/sessions';
import { reportError } from '../../stores/toasts';
import { useUi } from '../../stores/ui';

const DEBOUNCE_MS = 120;

/** Wraps case-insensitive occurrences of the query's words in <mark>. */
export function highlight(text: string, query: string): ReactNode {
  const words = query
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (words.length === 0) return text;
  const parts = text.split(new RegExp(`(${words.join('|')})`, 'gi'));
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="rounded-[2px] bg-[var(--g-mark-bg)] text-fg-strong underline decoration-fg-muted underline-offset-2">
        {part}
      </mark>
    ) : (
      part
    )
  );
}

type Outcome = { query: string; results: SearchResult[] } | { query: string; error: string };

function open(result: Pick<SearchResult, 'sessionId' | 'kind'>): void {
  const mode = useApp.getState().settings?.ui.mode;
  if (mode !== result.kind) {
    useApp
      .getState()
      .updateSettings({ ui: { mode: result.kind } })
      .catch((error: unknown) => reportError("Couldn't switch modes", error));
  }
  useNav.getState().go({ name: 'session', id: result.sessionId });
  useUi.getState().setSearchOpen(false);
}

/** Search contents; mounted only while the dialog is open, so each opening starts fresh. */
function SearchPanel() {
  const summaries = useSessions((s) => s.summaries);
  const [query, setQuery] = useState('');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [active, setActive] = useState(0);
  const listId = useId();
  const q = query.trim();

  useEffect(() => {
    if (q.length === 0) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      invoke('search:query', { query: q, kind: null })
        .then((results) => {
          if (!cancelled) setOutcome({ query: q, results });
        })
        .catch((error: unknown) => {
          if (!cancelled) setOutcome({ query: q, error: errorText(error) });
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q]);

  const recent: SearchResult[] = useMemo(
    () =>
      Object.values(summaries)
        .filter((s) => !s.archived)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 8)
        .map((s) => ({ sessionId: s.id, title: s.title, kind: s.kind, projectName: s.projectName, snippet: '', updatedAt: s.updatedAt })),
    [summaries]
  );

  const current = outcome && outcome.query === q ? outcome : null;
  const loading = q.length > 0 && current === null;
  const failed = current && 'error' in current ? current.error : null;
  const results = q.length === 0 ? recent : current && 'results' in current ? current.results : [];
  const activeIndex = Math.min(active, Math.max(0, results.length - 1));

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = Math.min(results.length - 1, Math.max(0, activeIndex + (event.key === 'ArrowDown' ? 1 : -1)));
      setActive(next);
      document.getElementById(`${listId}-${next}`)?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      const hit = results[activeIndex];
      if (hit) {
        event.preventDefault();
        open(hit);
      }
    }
  };

  return (
    <>
      <div className="flex items-center gap-8 border-b border-border px-14">
        <Search className="size-16 shrink-0 text-icon-muted" aria-hidden="true" />
        <input
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={results.length > 0 ? `${listId}-${activeIndex}` : undefined}
          aria-label="Search"
          value={query}
          onChange={(e) => {
            // ">" switches to the command palette, as in code editors.
            if (e.target.value.startsWith('>')) {
              useUi.getState().setPaletteOpen(true, e.target.value.slice(1).trimStart());
              return;
            }
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Search chats and sessions, or type > for commands"
          spellCheck={false}
          className="h-44 min-w-0 flex-1 bg-transparent text-md text-fg outline-none"
        />
        {loading ? <Spinner size={14} label="Searching" /> : null}
      </div>
      <div id={listId} role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto p-4">
        {q.length === 0 && recent.length > 0 ? <p className="px-8 pt-4 pb-2 text-sm text-fg-muted">Recent</p> : null}
        {failed ? (
          <p role="alert" className="px-8 py-12 text-base text-danger">
            Search failed: {failed}
          </p>
        ) : null}
        {current && !failed && results.length === 0 ? <p className="px-8 py-12 text-base text-fg-muted">Nothing matches “{q}”.</p> : null}
        {q.length === 0 && recent.length === 0 ? <p className="px-8 py-12 text-base text-fg-muted">No sessions yet.</p> : null}
        {results.map((r, i) => (
          <div
            key={r.sessionId}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={i === activeIndex}
            onMouseMove={() => setActive(i)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => open(r)}
            className={cn('flex cursor-default items-start gap-10 rounded-md px-8 py-6', i === activeIndex && 'bg-hover')}
          >
            {r.kind === 'code' ? (
              <Code className="mt-2 size-14 shrink-0 text-icon-muted" aria-label="Code session" />
            ) : (
              <MessagesSquare className="mt-2 size-14 shrink-0 text-icon-muted" aria-label="Chat" />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-8">
                <span className="min-w-0 flex-1 truncate text-base text-fg">{highlight(r.title, q)}</span>
                <span className="shrink-0 text-sm text-fg-muted">{relativeTime(r.updatedAt)}</span>
              </div>
              {r.snippet || r.projectName ? (
                <p className="truncate text-sm text-fg-muted">
                  {r.projectName ? <span className="text-fg-tertiary">{r.projectName}</span> : null}
                  {r.projectName && r.snippet ? ' · ' : null}
                  {r.snippet ? highlight(r.snippet, q) : null}
                </p>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/** Ctrl+K: fuzzy titles plus full-text message search across all sessions. */
export function SearchDialog() {
  const isOpen = useUi((s) => s.searchOpen);
  const setOpen = useUi((s) => s.setSearchOpen);
  return (
    <RD.Root open={isOpen} onOpenChange={setOpen}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-[var(--g-z-dialog)] bg-overlay data-[state=open]:animate-[graft-fade_var(--g-duration-base)_var(--g-ease)]" />
        <RD.Content
          aria-label="Search sessions"
          className="fixed top-[12vh] left-1/2 z-[var(--g-z-dialog)] flex max-h-[70vh] w-[min(620px,calc(100vw-48px))] -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-popover outline-none data-[state=open]:animate-[graft-menu-in_var(--g-duration-base)_var(--g-ease)]"
        >
          <RD.Title className="sr-only">Search sessions</RD.Title>
          <RD.Description className="sr-only">Search chat and session titles and messages.</RD.Description>
          {isOpen ? <SearchPanel /> : null}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
