import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { CaseSensitive, ChevronRight, ListFilter, RefreshCw, Regex, Replace, Search, Send, WholeWord } from 'lucide-react';
import type { TextSearchQuery } from '@shared/schemas/textSearch';
import { IconButton } from '../../components/Button';
import { Spinner } from '../../components/ContextRing';
import { cn } from '../../lib/cn';
import { usePanels } from '../../stores/panels';
import { searchOf, useTextSearch } from '../../stores/textSearch';
import { notify } from '../../stores/toasts';
import { useUi } from '../../stores/ui';
import { withRequest } from './problemsModel';
import { pieces, replaceRequest, resultsText, searchSummary } from './searchModel';

/** The box searches this long after the last change to it; Enter searches at once. */
const TYPING_PAUSE_MS = 250;

function sameQuery(a: TextSearchQuery, b: TextSearchQuery | null): boolean {
  return b !== null && a.text === b.text && a.regex === b.regex && a.caseSensitive === b.caseSensitive && a.wholeWord === b.wholeWord && a.files === b.files;
}

/**
 * Text search over the session's folder: every line that holds what is in
 * the box, under its file. A line opens its file in the editor at the match.
 * There is no replace here: the replacement is typed and composed into a
 * request for the agent, which changes the files in a turn with a checkpoint
 * and a diff. What is in the box and what was found live in the window's
 * state, since this view is taken down while the Files tab shows a file, and
 * reads the same when the user comes back to it.
 */
export function SearchView({ sessionId, refreshKey }: { sessionId: string; refreshKey: unknown }) {
  const search = useTextSearch((s) => searchOf(s, sessionId));
  const focus = useTextSearch((s) => s.focus);
  const [narrowing, setNarrowing] = useState(() => search.query.files.length > 0);
  // Open from the start when a replacement is already typed; the tab is taken down while a file shows, and comes back to it.
  const [replacing, setReplacing] = useState(() => search.replace.length > 0);
  const boxRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  /** Set by the press that opens the replacement box, so it takes the keyboard then and not when the tab is shown again. */
  const focusReplace = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  const filesNow = useRef(refreshKey);
  useEffect(() => {
    filesNow.current = refreshKey;
  }, [refreshKey]);
  const { query, result } = search;

  useEffect(() => {
    if (!replacing || !focusReplace.current) return;
    focusReplace.current = false;
    replaceRef.current?.focus();
  }, [replacing]);

  // The keyboard goes to the box when it was asked for: by the key, or by choosing the tab. A tab that is only
  // shown again, because its session came back on screen, leaves the keyboard to the message box.
  useEffect(() => {
    if (focus?.sessionId !== sessionId || !useTextSearch.getState().takeFocus(sessionId)) return;
    boxRef.current?.focus();
    boxRef.current?.select();
  }, [focus, sessionId]);

  const searchNow = (): void => void useTextSearch.getState().run(sessionId, filesNow.current);

  // A change to the box searches once typing pauses. What is listed already is not searched for again.
  const searched = search.searched;
  const settled = search.status !== 'idle' || query.text.trim().length > 0;
  useEffect(() => {
    if (!settled || sameQuery(query, searched)) return;
    const timer = setTimeout(() => void useTextSearch.getState().run(sessionId, filesNow.current), query.text.trim().length === 0 ? 0 : TYPING_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [sessionId, query, searched, settled]);

  const change = (patch: Partial<TextSearchQuery>): void => useTextSearch.getState().change(sessionId, patch);

  /** Arrow keys walk the box and the rows as one column. */
  const walk = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-search-row]') ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'ArrowDown' ? rows[at + 1] : at <= 0 ? boxRef.current : rows[at - 1];
    if (!next) return;
    event.preventDefault();
    next.focus();
  };

  const send = (): void => {
    if (!result || !searched) return;
    useUi.getState().sendToComposer(sessionId, { files: [{ name: 'search-results.txt', content: resultsText(searched, result) }] });
    notify('The results added to your message');
  };

  /**
   * The first press opens where the replacement is typed; the next ones put the
   * request in the message box. Nothing is replaced and nothing is sent here:
   * a change to many files belongs in a turn, with its checkpoint and its diff.
   */
  const askReplace = (): void => {
    if (!replacing) {
      focusReplace.current = true;
      setReplacing(true);
      return;
    }
    if (!result || !searched || search.replace.trim().length === 0) return;
    const ui = useUi.getState();
    ui.setDraft(sessionId, withRequest(ui.drafts[sessionId] ?? '', replaceRequest(searched, search.replace, result)));
    ui.focusComposer?.();
    notify('The replace request added to your message');
  };

  const toggles: Array<{ key: 'caseSensitive' | 'wholeWord' | 'regex'; label: string; icon: typeof Regex }> = [
    { key: 'caseSensitive', label: 'Match case', icon: CaseSensitive },
    { key: 'wholeWord', label: 'Match whole words', icon: WholeWord },
    { key: 'regex', label: 'Use a regular expression', icon: Regex }
  ];
  const stale = search.status === 'done' && search.at !== refreshKey;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <form
        role="search"
        aria-label="Search in files"
        onSubmit={(event) => {
          event.preventDefault();
          searchNow();
        }}
        className="flex shrink-0 flex-col gap-4 border-b border-border-panel p-6"
      >
        <div className="flex h-26 items-center gap-2 rounded-sm border border-input-border bg-input pr-2 pl-6 focus-within:border-border-strong">
          <Search className="size-13 shrink-0 text-icon-muted" aria-hidden="true" />
          <input
            ref={boxRef}
            value={query.text}
            onChange={(event) => change({ text: event.target.value })}
            onKeyDown={walk}
            aria-label="Search in files"
            placeholder="Search in files"
            spellCheck={false}
            className="h-full min-w-0 flex-1 bg-transparent px-4 font-mono text-sm text-fg outline-none placeholder:font-sans placeholder:text-fg-faint"
          />
          {toggles.map((toggle) => (
            <IconButton key={toggle.key} label={toggle.label} size="xs" aria-pressed={query[toggle.key]} active={query[toggle.key]} className={cn(query[toggle.key] && 'text-accent')} onClick={() => change({ [toggle.key]: !query[toggle.key] })}>
              <toggle.icon className="size-14" />
            </IconButton>
          ))}
          <IconButton label="Files to look in or leave out" size="xs" aria-pressed={narrowing} active={narrowing} className={cn(query.files.trim() && 'text-accent')} onClick={() => setNarrowing(!narrowing)}>
            <ListFilter className="size-13" />
          </IconButton>
        </div>
        {narrowing ? (
          <input
            value={query.files}
            onChange={(event) => change({ files: event.target.value })}
            aria-label="Files to look in or leave out"
            placeholder="src/**/*.ts, !**/*.test.ts"
            spellCheck={false}
            className="h-24 min-w-0 rounded-sm border border-input-border bg-input px-8 font-mono text-xs text-fg outline-none placeholder:text-fg-faint focus:border-border-strong"
          />
        ) : null}
        {replacing ? (
          <input
            ref={replaceRef}
            value={search.replace}
            onChange={(event) => useTextSearch.getState().setReplace(sessionId, event.target.value)}
            aria-label="Replace with"
            placeholder="Replace with"
            spellCheck={false}
            className="h-24 min-w-0 rounded-sm border border-input-border bg-input px-8 font-mono text-xs text-fg outline-none placeholder:text-fg-faint focus:border-border-strong"
          />
        ) : null}
      </form>
      <div className="flex h-28 shrink-0 items-center gap-4 border-b border-border-panel pr-4 pl-10 text-sm text-fg-muted">
        <span role="status" className="flex min-w-0 flex-1 items-center gap-6 truncate">
          {search.status === 'searching' ? (
            <>
              <Spinner size={12} label="Searching" />
              Searching…
            </>
          ) : result ? (
            searchSummary(result)
          ) : (
            'Text in the files of this folder'
          )}
        </span>
        <IconButton label="Search again" size="xs" disabled={query.text.trim().length === 0 || search.status === 'searching'} onClick={searchNow}>
          <RefreshCw className="size-12" />
        </IconButton>
        <IconButton label="Ask Graft to replace the matches" size="xs" disabled={!result || result.lines === 0 || (replacing && search.replace.trim().length === 0)} onClick={askReplace}>
          <Replace className="size-13" />
        </IconButton>
        <IconButton label="Send the results to chat" size="xs" disabled={!result || result.lines === 0} onClick={send}>
          <Send className="size-13" />
        </IconButton>
      </div>
      <div ref={listRef} onKeyDown={walk} className="min-h-0 flex-1 overflow-y-auto py-2">
        {search.status === 'error' ? (
          <p role="alert" className="selectable px-10 py-8 text-sm text-danger">
            {search.error}
          </p>
        ) : null}
        {stale ? <p className="px-10 pt-6 pb-2 text-sm text-amber-fg">The files have changed since this search. Search again to see them as they are.</p> : null}
        {!result && search.status !== 'error' && search.status !== 'searching' ? (
          <p className="px-10 py-8 text-base text-fg-muted">Every line that holds what you type, in every file of this folder. What git ignores is left out.</p>
        ) : null}
        {result?.files.map((file) => {
          const folded = search.folded[file.path] === true;
          const name = file.path.slice(file.path.lastIndexOf('/') + 1);
          const dir = file.path.slice(0, Math.max(0, file.path.length - name.length - 1));
          return (
            <section key={file.path} aria-label={file.path}>
              <button
                type="button"
                data-search-row=""
                aria-expanded={!folded}
                title={file.path}
                onClick={() => useTextSearch.getState().toggleFold(sessionId, file.path)}
                className="flex h-24 w-full items-center gap-4 pr-8 pl-6 text-left text-sm hover:bg-hover focus-visible:bg-hover"
              >
                <ChevronRight className={cn('size-12 shrink-0 text-icon-muted transition-transform', !folded && 'rotate-90')} aria-hidden="true" />
                <span className="shrink-0 truncate text-fg">{name}</span>
                {dir ? <span className="min-w-0 truncate text-2xs text-fg-faint">{dir}</span> : null}
                <span className="ml-auto shrink-0 rounded-full bg-control px-6 text-2xs text-fg-muted tabular-nums" aria-label={`${String(file.matches.length)} ${file.matches.length === 1 ? 'line' : 'lines'}`}>
                  {file.matches.length}
                </span>
              </button>
              {folded ? null : (
                <ul>
                  {file.matches.map((match) => (
                    <li key={`${String(match.line)}:${String(match.column)}`}>
                      <button
                        type="button"
                        data-search-row=""
                        aria-label={`${file.path} line ${String(match.line)}: ${match.text}`}
                        onClick={() => usePanels.getState().openFile(sessionId, file.path, { line: match.line, column: match.column })}
                        className="flex w-full items-baseline gap-8 py-2 pr-8 pl-22 text-left hover:bg-hover focus-visible:bg-hover"
                      >
                        <span className="w-[34px] shrink-0 text-right font-mono text-2xs text-fg-faint tabular-nums">{match.line}</span>
                        <span className="min-w-0 flex-1 truncate font-mono text-[calc(var(--g-code-font-size)-2px)] leading-[1.6] whitespace-pre text-fg-secondary">
                          {pieces(match.text, match.ranges).map((piece, i) =>
                            piece.hit ? (
                              <mark key={i} className="rounded-xs bg-amber/30 text-fg">
                                {piece.text}
                              </mark>
                            ) : (
                              piece.text
                            )
                          )}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
