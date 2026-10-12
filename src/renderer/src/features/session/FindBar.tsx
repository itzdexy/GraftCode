import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { IconButton } from '../../components/Button';
import { countLabel, findMatches, stepMatch } from './findModel';

/** How long after the transcript changes the search runs again. */
const AGAIN_MS = 150;
/** Text the page holds and does not show, or that is not the conversation's own. */
const NOT_SHOWN = '[aria-hidden="true"], .sr-only, [inert], .select-none';
/** What a match may not run across: the nearest of these around a piece of text is its block. */
const BLOCK = 'p, li, pre, td, th, h1, h2, h3, h4, h5, h6, blockquote, summary, [data-find-block]';
const MARK = 'graft-find';
const MARK_CURRENT = 'graft-find-current';
/** A match nearer than this to the transcript's top or bottom edge is brought to the middle. */
const EDGE = 56;

/** The text nodes the transcript shows, in order, grouped by the block each is in. */
function shownText(root: HTMLElement): { nodes: Text[]; blocks: string[][] } {
  const nodes: Text[] = [];
  const blocks: string[][] = [];
  let last: Element | null = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!(node instanceof Text) || node.data.length === 0 || parent === null || parent.closest(NOT_SHOWN) !== null) continue;
    const block = parent.closest(BLOCK) ?? parent;
    if (block !== last || blocks.length === 0) {
      blocks.push([]);
      last = block;
    }
    blocks.at(-1)?.push(node.data);
    nodes.push(node);
  }
  return { nodes, blocks };
}

/**
 * Where a search starts: the first match on screen or below it, as a find in
 * an editor starts at the cursor and not at the top of the file; the last
 * match when all of them are above. Matches are in the page's order, so the
 * one is found by halving.
 */
function firstInView(ranges: Range[], scroller: HTMLElement): number {
  const top = scroller.getBoundingClientRect().top;
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((ranges[middle]?.getBoundingClientRect().bottom ?? 0) < top) low = middle + 1;
    else high = middle;
  }
  return Math.min(low, Math.max(0, ranges.length - 1));
}

export interface FindBarHandle {
  /** Puts the keyboard in the box with its text selected: what the shortcut does to a bar that is already open. */
  focus: () => void;
}

interface FindBarProps {
  /** The element whose text is searched. */
  root: RefObject<HTMLElement | null>;
  /** The element that scrolls it. */
  scroller: RefObject<HTMLElement | null>;
  onClose: () => void;
}

/**
 * Find in the conversation: a small bar over the transcript's top right
 * corner. It marks the text the transcript shows with CSS highlights, so no
 * element of the page changes, and searches again shortly after the transcript
 * does. What is folded away is not on the page, and is found once it is opened.
 */
export const FindBar = forwardRef<FindBarHandle, FindBarProps>(function FindBar({ root, scroller, onClose }, ref) {
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ query: string; ranges: Range[]; more: boolean }>({ query: '', ranges: [], more: false });
  const [current, setCurrent] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  /** Where the keyboard was when the bar opened: closing gives it back. */
  const [cameFrom] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  /** The text whose starting match was chosen, so the same text found again (the transcript changed) keeps its place. */
  const started = useRef<string | null>(null);
  /** The match last brought into view, so finding it again does not pull the transcript back to it. */
  const revealed = useRef('');

  useImperativeHandle(ref, () => ({ focus: () => input.current?.select() }), []);
  useEffect(() => input.current?.focus(), []);

  const search = useCallback((): void => {
    const within = root.current;
    if (!within || query.length === 0) {
      started.current = null;
      setFound({ query, ranges: [], more: false });
      return;
    }
    const { nodes, blocks } = shownText(within);
    const { matches, more } = findMatches(blocks, query);
    const ranges: Range[] = [];
    for (const match of matches) {
      const from = nodes[match.start.node];
      const to = nodes[match.end.node];
      if (!from || !to) continue;
      const range = document.createRange();
      range.setStart(from, match.start.offset);
      range.setEnd(to, match.end.offset);
      ranges.push(range);
    }
    if (ranges.length > 0 && started.current !== query) {
      started.current = query;
      setCurrent(scroller.current ? firstInView(ranges, scroller.current) : 0);
    }
    setFound({ query, ranges, more });
  }, [root, scroller, query]);

  // Searches when the text typed changes, and again a moment after the transcript does. A reply that streams
  // changes the transcript many times a second: one search then covers all the changes of that moment.
  useEffect(() => {
    const within = root.current;
    if (!within) return;
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      timer = null;
      search();
    }, 0);
    const observer = new MutationObserver(() => {
      timer ??= setTimeout(() => {
        timer = null;
        search();
      }, AGAIN_MS);
    });
    observer.observe(within, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (timer !== null) clearTimeout(timer);
    };
  }, [root, search]);

  // The current match keeps its number while it still exists.
  const total = found.ranges.length;
  const shown = total === 0 ? 0 : Math.min(current, total - 1);

  // The marks: every match, and the current one stronger over them. Nothing in the page is changed for them.
  useEffect(() => {
    CSS.highlights.delete(MARK);
    CSS.highlights.delete(MARK_CURRENT);
    const range = found.ranges[shown];
    if (!range) return;
    CSS.highlights.set(MARK, new Highlight(...found.ranges));
    const strong = new Highlight(range);
    strong.priority = 1;
    CSS.highlights.set(MARK_CURRENT, strong);
  }, [found, shown]);
  useEffect(
    () => () => {
      CSS.highlights.delete(MARK);
      CSS.highlights.delete(MARK_CURRENT);
    },
    []
  );

  // The current match is brought to the middle of the transcript when it is not comfortably on screen already.
  useEffect(() => {
    const range = found.ranges[shown];
    const box = scroller.current;
    const key = `${found.query}\n${String(shown)}`;
    if (!range || !box || revealed.current === key) return;
    revealed.current = key;
    const at = range.getBoundingClientRect();
    const view = box.getBoundingClientRect();
    if (at.top < view.top + EDGE || at.bottom > view.bottom - EDGE) box.scrollTo({ top: box.scrollTop + at.top - view.top - (view.height - at.height) / 2 });
  }, [found, shown, scroller]);

  const close = (): void => {
    onClose();
    if (cameFrom?.isConnected) cameFrom.focus();
  };
  const step = (direction: 1 | -1): void => setCurrent(stepMatch(shown, total, direction));
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      // Escape closes the bar and nothing else: the page would also take it for "stop the running session".
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Enter' && event.target === input.current) {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    }
  };

  return (
    <div
      role="search"
      aria-label="Find in the conversation"
      onKeyDown={onKeyDown}
      className="motion-menu-down absolute top-8 right-20 z-[var(--g-z-sticky)] flex h-32 max-w-[calc(100%-40px)] items-center gap-2 rounded-md border border-border bg-surface pr-4 pl-8 shadow-popover"
    >
      <Search className="size-13 shrink-0 text-icon-muted" aria-hidden="true" />
      <input
        ref={input}
        type="text"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        aria-label="Find in the conversation"
        placeholder="Find"
        spellCheck={false}
        autoComplete="off"
        className="h-full w-[168px] min-w-[56px] shrink bg-transparent px-6 text-base text-fg outline-none placeholder:text-fg-faint"
      />
      <span aria-live="polite" className="min-w-[58px] shrink-0 px-4 text-right text-xs text-fg-muted tabular-nums">
        {found.query.length === 0 ? '' : countLabel(shown, total, found.more)}
      </span>
      <span className="mx-2 h-14 w-px shrink-0 bg-divider" aria-hidden="true" />
      <IconButton label="Previous match" shortcut="Shift+Enter" size="xs" disabled={total === 0} onClick={() => step(-1)}>
        <ChevronUp className="size-14" />
      </IconButton>
      <IconButton label="Next match" shortcut="Enter" size="xs" disabled={total === 0} onClick={() => step(1)}>
        <ChevronDown className="size-14" />
      </IconButton>
      <IconButton label="Close" shortcut="Esc" size="xs" onClick={close}>
        <X className="size-14" />
      </IconButton>
    </div>
  );
});
