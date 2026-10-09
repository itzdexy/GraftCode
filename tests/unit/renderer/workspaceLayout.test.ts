import { describe, expect, it } from 'vitest';
import { closeWorkspaceTab, emptyWorkspaceLayout, loadWorkspaceLayout, MAX_WORKSPACE_SESSIONS, MAX_WORKSPACE_TABS, openWorkspaceTab, saveWorkspaceLayout, setWorkspaceTabMode, WORKSPACE_LAYOUT_KEY } from '../../../src/renderer/src/features/panels/workspaceLayout';

function storage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

describe('editor workspace layout', () => {
  it('deduplicates paths, retains order and remembers each file mode', () => {
    let layout = openWorkspaceTab(emptyWorkspaceLayout(), 'src/a.ts', 'preview');
    layout = setWorkspaceTabMode(layout, 'src/a.ts', 'edit');
    layout = openWorkspaceTab(layout, 'src/b.ts', 'preview');
    layout = openWorkspaceTab(layout, 'src/a.ts', 'edit');
    expect(layout).toEqual({ activePath: 'src/a.ts', tabs: [{ path: 'src/a.ts', mode: 'edit' }, { path: 'src/b.ts', mode: 'preview' }] });
  });

  it('closing an active tab selects its neighbor; closing the last returns to the tree', () => {
    let layout = emptyWorkspaceLayout();
    for (const path of ['a.ts', 'b.ts', 'c.ts']) layout = openWorkspaceTab(layout, path, 'preview');
    expect(closeWorkspaceTab(layout, 'a.ts').activePath).toBe('c.ts');
    layout = closeWorkspaceTab(layout, 'c.ts');
    expect(layout.activePath).toBe('b.ts');
    layout = closeWorkspaceTab(layout, 'b.ts');
    expect(layout.activePath).toBe('a.ts');
    expect(closeWorkspaceTab(layout, 'a.ts')).toEqual(emptyWorkspaceLayout());
  });

  it('bounds open tabs and rejects paths that cannot identify safe relative project files', () => {
    let layout = emptyWorkspaceLayout();
    for (let i = 0; i < MAX_WORKSPACE_TABS + 4; i++) layout = openWorkspaceTab(layout, `file${i}.ts`, 'preview');
    expect(layout.tabs).toHaveLength(MAX_WORKSPACE_TABS);
    expect(layout.tabs[0]?.path).toBe('file4.ts');
    for (const path of ['/abs.ts', '../outside.ts', 'a/../b.ts', 'C:/file.ts', 'a\\file.ts', '.git/config', 'a//b.ts', 'x\u0000.ts']) {
      expect(openWorkspaceTab(layout, path, 'edit')).toBe(layout);
    }
  });

  it('round trips session-local metadata without source text or extra fields', () => {
    const target = storage();
    const layout = openWorkspaceTab(emptyWorkspaceLayout(), 'a.ts', 'edit');
    saveWorkspaceLayout('session-a', layout, target);
    saveWorkspaceLayout('session-b', openWorkspaceTab(emptyWorkspaceLayout(), 'b.ts', 'preview'), target);
    expect(loadWorkspaceLayout('session-a', target)).toEqual(layout);
    expect(loadWorkspaceLayout('unknown', target)).toEqual(emptyWorkspaceLayout());
    const raw = target.getItem(WORKSPACE_LAYOUT_KEY)!;
    const stored = JSON.parse(raw) as { sessions: Array<{ layout: { tabs: Array<Record<string, unknown>> } }> };
    expect(Object.keys(stored.sessions[0]!.layout.tabs[0]!).sort()).toEqual(['mode', 'path']);
    saveWorkspaceLayout('session-a', { ...layout, content: 'private source' } as typeof layout, target);
    expect(target.getItem(WORKSPACE_LAYOUT_KEY)).toBe(raw);
  });

  it('caps retained sessions and treats malformed, unsafe or future-version metadata as empty', () => {
    const target = storage();
    for (let i = 0; i < MAX_WORKSPACE_SESSIONS + 3; i++) saveWorkspaceLayout(`session-${i}`, emptyWorkspaceLayout(), target);
    expect((JSON.parse(target.getItem(WORKSPACE_LAYOUT_KEY)!) as { sessions: unknown[] }).sessions).toHaveLength(MAX_WORKSPACE_SESSIONS);
    for (const raw of ['broken', '{"version":2,"sessions":[]}', JSON.stringify({ version: 1, sessions: [{ id: 'test', updatedAt: 1, layout: { tabs: [{ path: '../outside', mode: 'edit' }], activePath: '../outside' } }] })]) {
      target.setItem(WORKSPACE_LAYOUT_KEY, raw);
      expect(loadWorkspaceLayout('test', target)).toEqual(emptyWorkspaceLayout());
    }
  });

  it('rejects duplicate paths, missing active tabs and unexpected source fields from storage', () => {
    const target = storage();
    const layouts = [
      { tabs: [{ path: 'a.ts', mode: 'preview' }, { path: 'a.ts', mode: 'edit' }], activePath: 'a.ts' },
      { tabs: [{ path: 'a.ts', mode: 'preview' }], activePath: 'missing.ts' },
      { tabs: [{ path: 'a.ts', mode: 'edit', content: 'source text' }], activePath: 'a.ts' }
    ];
    for (const layout of layouts) {
      target.setItem(WORKSPACE_LAYOUT_KEY, JSON.stringify({ version: 1, sessions: [{ id: 'session', updatedAt: 1, layout }] }));
      expect(loadWorkspaceLayout('session', target)).toEqual(emptyWorkspaceLayout());
    }
  });

  it('continues editing when local storage is unavailable', () => {
    const unavailable = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('full'); } };
    expect(loadWorkspaceLayout('session', unavailable)).toEqual(emptyWorkspaceLayout());
    expect(() => saveWorkspaceLayout('session', emptyWorkspaceLayout(), unavailable)).not.toThrow();
  });
});
