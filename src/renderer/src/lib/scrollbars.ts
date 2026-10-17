import { useEffect } from 'react';

/** How long a scrolled area keeps its bar lit after the last scroll. */
export const SCROLLING_MS = 900;
export const SCROLLING_CLASS = 'graft-scrolling';

/**
 * Lights the scrollbar of whatever is being scrolled (globals.css draws a
 * lit thumb for .graft-scrolling) and dims it again a moment after it stops:
 * bars stay quiet until they are used. One listener for the whole page, so
 * no scrolling area has to ask for it.
 */
export function markScrolling(root: EventTarget & { documentElement: Element }): () => void {
  const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>();
  const onScroll = (event: Event): void => {
    // The page itself scrolling reports the document; its bar belongs to the root element.
    const scrolled: unknown = event.target === root ? root.documentElement : event.target;
    if (!scrolled || typeof scrolled !== 'object' || !('classList' in scrolled)) return;
    const target = scrolled as Element;
    target.classList.add(SCROLLING_CLASS);
    const previous = timers.get(target);
    if (previous !== undefined) clearTimeout(previous);
    timers.set(
      target,
      setTimeout(() => target.classList.remove(SCROLLING_CLASS), SCROLLING_MS)
    );
  };
  root.addEventListener('scroll', onScroll, { capture: true, passive: true });
  return () => root.removeEventListener('scroll', onScroll, { capture: true });
}

export function useScrollingMarks(): void {
  useEffect(() => markScrolling(document), []);
}
