import { beforeEach, describe, expect, it } from 'vitest';
import { firstChangedLine } from '../../../src/renderer/src/features/diff/diffModel';
import { panelsOf, usePanels } from '../../../src/renderer/src/stores/panels';

beforeEach(() => usePanels.setState({ bySession: {}, fileRequest: null, terminalInput: null }));

describe('opening a file from outside the Files panel', () => {
  it('shows the Files view and leaves one request for it', () => {
    usePanels.getState().openFile('s', 'src\\health.js', { line: 14 });
    expect(panelsOf(usePanels.getState(), 's')).toMatchObject({ open: ['changes'], changesTab: 'files' });
    expect(usePanels.getState().takeFileRequest('other')).toBeNull();
    expect(usePanels.getState().takeFileRequest('s')).toMatchObject({ sessionId: 's', path: 'src/health.js', line: 14, column: null });
    expect(usePanels.getState().takeFileRequest('s')).toBeNull();
  });

  it('counts each request, so the same file can be asked for twice', () => {
    usePanels.getState().openFile('s', 'a.ts');
    const first = usePanels.getState().fileRequest?.seq ?? 0;
    usePanels.getState().openFile('s', 'a.ts', { line: 3, column: 7 });
    expect(usePanels.getState().fileRequest).toMatchObject({ line: 3, column: 7, seq: first + 1 });
    expect(panelsOf(usePanels.getState(), 's').open).toEqual(['changes']);
  });

  it('keeps counting after a request was taken, so the next one is seen as new', () => {
    usePanels.getState().openFile('s', 'a.ts');
    const first = usePanels.getState().fileRequest?.seq ?? 0;
    usePanels.getState().takeFileRequest('s');
    usePanels.getState().openFile('s', 'a.ts');
    expect(usePanels.getState().fileRequest?.seq).toBe(first + 1);
  });
});

describe('opening the search from outside the panel', () => {
  it('shows the Search tab of the session, in the panel that was open or a new one', () => {
    usePanels.getState().showSearch('s');
    expect(panelsOf(usePanels.getState(), 's')).toMatchObject({ open: ['changes'], changesTab: 'search' });
    usePanels.getState().setChangesTab('s', 'files');
    usePanels.getState().showSearch('s');
    expect(panelsOf(usePanels.getState(), 's')).toMatchObject({ open: ['changes'], changesTab: 'search' });
    expect(panelsOf(usePanels.getState(), 'other').open).toEqual([]);
  });
});

describe('where a change starts', () => {
  it('is the first added line, or where lines were removed', () => {
    expect(firstChangedLine('--- a\n+++ b\n@@ -1,4 +1,5 @@\n one\n two\n+three\n four\n')).toBe(3);
    expect(firstChangedLine('--- a\n+++ b\n@@ -10,3 +10,2 @@\n ten\n-eleven\n twelve\n')).toBe(11);
    expect(firstChangedLine('--- a\n+++ b\n@@ -0,0 +1,2 @@\n+a\n+b\n')).toBe(1);
    expect(firstChangedLine('--- a\n+++ b\n@@ -3,2 +3,1 @@\n three\n-four\n')).toBe(4);
    expect(firstChangedLine('')).toBe(1);
  });
});

describe('typing into the terminal from outside it', () => {
  it('shows the Terminal panel and leaves the line to be taken once', () => {
    usePanels.getState().typeInTerminal('s', 'npm test');
    expect(panelsOf(usePanels.getState(), 's').open).toEqual(['terminal']);
    expect(usePanels.getState().takeTerminalInput('other')).toBeNull();
    expect(usePanels.getState().takeTerminalInput('s')).toBe('npm test');
    expect(usePanels.getState().takeTerminalInput('s')).toBeNull();
  });
});
