import { afterEach, describe, expect, it, vi } from 'vitest';
import { markScrolling, SCROLLING_CLASS, SCROLLING_MS } from '../../../src/renderer/src/lib/scrollbars';

/** Just enough of an element: a class list. */
function element() {
  const classes = new Set<string>();
  return { classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c), contains: (c: string) => classes.has(c) } };
}

afterEach(() => vi.useRealTimers());

describe('a scrollbar while its area scrolls', () => {
  it('is lit while scrolling and a moment after, then dims', () => {
    vi.useFakeTimers();
    const root = new EventTarget() as EventTarget & { documentElement: ReturnType<typeof element> };
    root.documentElement = element();
    const stop = markScrolling(root as unknown as EventTarget & { documentElement: Element });
    const list = element();
    const scroll = (target: unknown): void => {
      const event = new Event('scroll');
      Object.defineProperty(event, 'target', { value: target });
      root.dispatchEvent(event);
    };
    scroll(list);
    expect(list.classList.contains(SCROLLING_CLASS)).toBe(true);
    vi.advanceTimersByTime(SCROLLING_MS - 100);
    // Scrolling on keeps it lit, counted from the last scroll.
    scroll(list);
    vi.advanceTimersByTime(SCROLLING_MS - 100);
    expect(list.classList.contains(SCROLLING_CLASS)).toBe(true);
    vi.advanceTimersByTime(200);
    expect(list.classList.contains(SCROLLING_CLASS)).toBe(false);
    // The page itself scrolling lights the root element's bar.
    scroll(root);
    expect(root.documentElement.classList.contains(SCROLLING_CLASS)).toBe(true);
    stop();
    const other = element();
    scroll(other);
    expect(other.classList.contains(SCROLLING_CLASS)).toBe(false);
  });
});
