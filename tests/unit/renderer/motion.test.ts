import { afterEach, describe, expect, it, vi } from 'vitest';
import { motionAttribute, motionReduced, subscribeVisibleClock } from '../../../src/renderer/src/lib/motion';

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
