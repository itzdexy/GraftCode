import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToasts } from '../../../src/renderer/src/stores/toasts';

const titles = (): string[] => useToasts.getState().toasts.map((t) => t.title);

describe('toasts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const toast of useToasts.getState().toasts) useToasts.getState().dismiss(toast.id);
  });
  afterEach(() => {
    useToasts.getState().release();
    vi.useRealTimers();
  });

  it('goes away on its own, and an error stays twice as long', () => {
    useToasts.getState().push({ tone: 'success', title: 'Saved' });
    useToasts.getState().push({ tone: 'error', title: 'Failed' });
    vi.advanceTimersByTime(5_000);
    expect(titles()).toEqual(['Failed']);
    vi.advanceTimersByTime(5_000);
    expect(titles()).toEqual([]);
  });

  it('stays for as long as the pointer rests on the toasts, so it can be read and its button reached', () => {
    useToasts.getState().push({ tone: 'success', title: 'Pull request created' });
    vi.advanceTimersByTime(4_000);
    useToasts.getState().hold();
    vi.advanceTimersByTime(60_000);
    expect(titles()).toEqual(['Pull request created']);
  });

  it('gives a toast a little more time after the pointer leaves, however close it was to going', () => {
    useToasts.getState().push({ tone: 'success', title: 'Copied' });
    vi.advanceTimersByTime(4_900);
    useToasts.getState().hold();
    useToasts.getState().release();
    vi.advanceTimersByTime(1_400);
    expect(titles()).toEqual(['Copied']);
    vi.advanceTimersByTime(200);
    expect(titles()).toEqual([]);
  });

  it('keeps the time a toast had left when that is longer', () => {
    useToasts.getState().push({ tone: 'error', title: 'Failed' });
    vi.advanceTimersByTime(2_000);
    useToasts.getState().hold();
    vi.advanceTimersByTime(30_000);
    useToasts.getState().release();
    vi.advanceTimersByTime(7_900);
    expect(titles()).toEqual(['Failed']);
    vi.advanceTimersByTime(200);
    expect(titles()).toEqual([]);
  });

  it('holds a toast that arrives while the pointer is already there', () => {
    useToasts.getState().hold();
    useToasts.getState().push({ tone: 'info', title: 'Branch pushed' });
    vi.advanceTimersByTime(20_000);
    expect(titles()).toEqual(['Branch pushed']);
  });
});
