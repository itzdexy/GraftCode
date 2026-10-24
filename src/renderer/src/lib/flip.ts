import { useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * Rows that travel to their new place when a list is put in another order
 * (first, last, invert, play). The arithmetic is pure and unit-tested; the
 * hook reads places from the page and animates with the Web Animations API.
 */

/** A row that would travel farther than this just appears there; and when more rows than this move at once (a filter, a search), none of them travels. */
export const FLIP_LIMITS = { maxDistance: 600, maxRows: 30 } as const;

/**
 * The rows that changed place, in their new order, with how far each has to
 * be put back to start where it was. Rows that stayed, rows that are new and
 * rows that left are not among them. None when too many moved at once.
 */
export function flipMoves(before: ReadonlyMap<string, number>, after: ReadonlyMap<string, number>, limits: { maxDistance: number; maxRows: number } = FLIP_LIMITS): Array<{ key: string; dy: number }> {
  const moved: Array<{ key: string; dy: number }> = [];
  for (const [key, now] of after) {
    const was = before.get(key);
    // Less than a pixel is rounding, not a move.
    if (was !== undefined && Math.abs(was - now) >= 1) moved.push({ key, dy: was - now });
  }
  if (moved.length > limits.maxRows) return [];
  return moved.filter((move) => Math.abs(move.dy) <= limits.maxDistance);
}

/** A CSS time as milliseconds: "180ms" is 180, "0.25s" is 250, anything else 0. */
export function durationMs(css: string): number {
  const time = /^(\d*\.?\d+)(ms|s)$/.exec(css.trim());
  if (!time) return 0;
  return Number(time[1]) * (time[2] === 's' ? 1000 : 1);
}

/** Where each row is inside its container, by its key; scrolling the container moves none of them. */
function places(container: HTMLElement): Map<string, number> {
  const top = container.getBoundingClientRect().top - container.scrollTop;
  const found = new Map<string, number>();
  for (const row of container.querySelectorAll<HTMLElement>('[data-flip-key]')) found.set(row.dataset.flipKey ?? '', row.getBoundingClientRect().top - top);
  return found;
}

/**
 * For a container whose rows carry `data-flip-key`: when `order` changes, the
 * rows that changed place travel there instead of jumping. The time is
 * --g-duration-base, so with motion reduced (the token is then zero) nothing
 * travels at all.
 */
export function useFlip<T extends HTMLElement>(order: string): RefObject<T> {
  const container = useRef<T>(null);
  /** Where the rows were when the order last changed. */
  const last = useRef<Map<string, number> | null>(null);
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const now = places(element);
    const before = last.current;
    last.current = now;
    if (before === null) return;
    const style = getComputedStyle(document.documentElement);
    const duration = durationMs(style.getPropertyValue('--g-duration-base'));
    if (duration === 0) return;
    const easing = style.getPropertyValue('--g-ease-out').trim() || 'ease-out';
    for (const { key, dy } of flipMoves(before, now)) {
      const row = element.querySelector<HTMLElement>(`[data-flip-key="${CSS.escape(key)}"]`);
      row?.animate([{ transform: `translateY(${String(dy)}px)` }, { transform: 'none' }], { duration, easing });
    }
  }, [order]);
  return container;
}
