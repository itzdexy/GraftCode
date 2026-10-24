import { afterEach, describe, expect, it, vi } from 'vitest';
import { lastShown, motionAttribute, motionReduced, SLIDE_EXIT_MS, subscribeVisibleClock, viewTransitionAllowed, withViewTransition } from '../../../src/renderer/src/lib/motion';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the Motion setting', () => {
  it('follows the system when set to System', () => {
    expect(motionReduced('system', true)).toBe(true);
    expect(motionReduced('system', false)).toBe(false);
  });

  it('animates when set to On, even when the system asks for less motion', () => {
    expect(motionReduced('on', true)).toBe(false);
  });

  it('stays still when set to Reduced, whatever the system says', () => {
    expect(motionReduced('reduced', false)).toBe(true);
  });

  it('marks the page only for On and Reduced, so System is left to the media query', () => {
    expect(motionAttribute('system')).toBeNull();
    expect(motionAttribute('on')).toBe('full');
    expect(motionAttribute('reduced')).toBe('reduced');
  });
});

describe('the working status clock', () => {
  it('pauses while hidden, catches up immediately on return and removes its timer and listener on unmount', () => {
    vi.useFakeTimers();
    const page = new EventTarget();
    const visibility = { hidden: false, addEventListener: page.addEventListener.bind(page), removeEventListener: page.removeEventListener.bind(page) };
    vi.stubGlobal('document', visibility);
    const tick = vi.fn();
    const unsubscribe = subscribeVisibleClock(tick);
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    expect(tick).toHaveBeenCalledTimes(3);

    visibility.hidden = true;
    page.dispatchEvent(new Event('visibilitychange'));
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60000);
    expect(tick).toHaveBeenCalledTimes(3);

    visibility.hidden = false;
    page.dispatchEvent(new Event('visibilitychange'));
    expect(tick).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(1);
    unsubscribe();
    expect(vi.getTimerCount()).toBe(0);
    page.dispatchEvent(new Event('visibilitychange'));
    expect(tick).toHaveBeenCalledTimes(4);
  });

  it('does not schedule updates if mounted in a hidden page', () => {
    vi.useFakeTimers();
    const page = new EventTarget();
    vi.stubGlobal('document', { hidden: true, addEventListener: page.addEventListener.bind(page), removeEventListener: page.removeEventListener.bind(page) });
    const tick = vi.fn();
    const unsubscribe = subscribeVisibleClock(tick);
    expect(tick).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    unsubscribe();
  });
});

/** A page that can fade, and whose fades the test starts and ends by hand. `sync` runs a fade's change the moment it is asked for; a browser runs it a frame later. */
function fadingPage(sync: boolean): { started: Array<() => void>; finish: () => Promise<void> } {
  const page = { started: [] as Array<() => void>, done: (): void => undefined };
  vi.stubGlobal('document', {
    hidden: false,
    documentElement: { dataset: { motion: 'full' } },
    startViewTransition: (callback: () => void) => {
      page.started.push(callback);
      if (sync) callback();
      const finished = new Promise<void>((resolve) => (page.done = resolve));
      return { finished, ready: Promise.resolve(), updateCallbackDone: Promise.resolve() };
    }
  });
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
  return {
    started: page.started,
    finish: async () => {
      page.done();
      await Promise.resolve();
      await Promise.resolve();
    }
  };
}

describe('a change of view', () => {
  const ok = { reduced: false, hidden: false, supported: true, running: false };

  it('cross-fades only when nothing speaks against it', () => {
    expect(viewTransitionAllowed(ok)).toBe(true);
    for (const key of ['reduced', 'hidden', 'running'] as const) expect(viewTransitionAllowed({ ...ok, [key]: true }), key).toBe(false);
    expect(viewTransitionAllowed({ ...ok, supported: false })).toBe(false);
  });

  it('is applied once and at once where there is no page to fade', () => {
    let applied = 0;
    withViewTransition(() => applied++);
    expect(applied).toBe(1);
  });

  it('fades through the browser when it can, and applies a second change at once while the first fades', async () => {
    const page = fadingPage(true);
    const order: string[] = [];
    withViewTransition(() => order.push('first'));
    withViewTransition(() => order.push('second'));
    expect(order).toEqual(['first', 'second']);
    expect(page.started).toHaveLength(1);
    await page.finish();
    withViewTransition(() => order.push('third'));
    expect(page.started).toHaveLength(2);
    await page.finish(); // leave nothing fading for the tests that follow
  });

  it('makes a change whose turn had not come before the one that follows it, and makes neither twice', async () => {
    // A browser takes its picture of the page first and runs the change a frame later.
    const page = fadingPage(false);
    const order: string[] = [];
    withViewTransition(() => order.push('first'));
    expect(order).toEqual([]);
    withViewTransition(() => order.push('second'));
    expect(order).toEqual(['first', 'second']);
    page.started[0]?.();
    expect(order).toEqual(['first', 'second']);
    await page.finish();
  });

  it('marks the window for as long as a change of page takes, so that the page alone can move', async () => {
    const page = fadingPage(true);
    const mark = (): string | undefined => (document as unknown as { documentElement: { dataset: { viewChange?: string } } }).documentElement.dataset.viewChange;
    withViewTransition(() => undefined, 'page');
    expect(mark()).toBe('page');
    await page.finish();
    expect(mark()).toBeUndefined();
    // Another kind of change (a theme, the transcript's view) fades the window as a whole.
    withViewTransition(() => undefined);
    expect(mark()).toBeUndefined();
    await page.finish();
  });

  it('leaves the window unmarked when a change of page is made at once', () => {
    fadingPage(true);
    const root = (document as unknown as { documentElement: { dataset: { motion: string; viewChange?: string } } }).documentElement;
    root.dataset.motion = 'reduced';
    withViewTransition(() => undefined, 'page');
    expect(root.dataset.viewChange).toBeUndefined();
  });

  it('does not fade with motion reduced or the window hidden, and still makes the change', () => {
    const page = fadingPage(true);
    (document as unknown as { documentElement: { dataset: { motion: string } } }).documentElement.dataset.motion = 'reduced';
    let applied = 0;
    withViewTransition(() => applied++);
    (document as unknown as { documentElement: { dataset: { motion: string } } }).documentElement.dataset.motion = 'full';
    (document as unknown as { hidden: boolean }).hidden = true;
    withViewTransition(() => applied++);
    expect(applied).toBe(2);
    expect(page.started).toHaveLength(0);
  });
});

describe('a column that slides shut', () => {
  it('keeps what it held while it goes', () => {
    expect(lastShown(['terminal'], ['changes'])).toEqual(['terminal']);
    expect(lastShown([], ['terminal', 'changes'])).toEqual(['terminal', 'changes']);
    expect(lastShown([], [])).toEqual([]);
    expect(SLIDE_EXIT_MS).toBe(180);
  });
});
