import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SIDE_WIDTH, SIDE_MIN, paneActive, usePanes } from '../../../src/renderer/src/stores/panes';

describe('the session beside the open one', () => {
  beforeEach(() => {
    usePanes.setState({ side: null, focus: 'main', width: DEFAULT_SIDE_WIDTH });
  });

  it('opens with the keyboard in the new pane, and closes back to the open session', () => {
    usePanes.getState().open('other');
    expect(usePanes.getState()).toMatchObject({ side: 'other', focus: 'side' });
    usePanes.getState().close();
    expect(usePanes.getState()).toMatchObject({ side: null, focus: 'main' });
  });

  it('gives the keyboard to the pane the user works in', () => {
    usePanes.getState().open('other');
    usePanes.getState().setFocus('main');
    expect(paneActive('other', 'main', 'main')).toBe(true);
    expect(paneActive('other', 'main', 'side')).toBe(false);
    usePanes.getState().setFocus('side');
    expect(paneActive('other', 'side', 'main')).toBe(false);
    expect(paneActive('other', 'side', 'side')).toBe(true);
    // With nothing beside the open session every key belongs to it, whatever the last split left behind.
    expect(paneActive(null, 'side', 'main')).toBe(true);
    expect(paneActive(null, 'side', 'side')).toBe(true);
  });

  it('keeps the side pane wide enough to work in', () => {
    usePanes.getState().setWidth(120.4);
    expect(usePanes.getState().width).toBe(SIDE_MIN);
    usePanes.getState().setWidth(642.6);
    expect(usePanes.getState().width).toBe(643);
  });
});
