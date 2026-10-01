import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UpdateState } from '../../src/shared/schemas/system';
import type { SessionSummary } from '../../src/shared/schemas/sessions';
import type { StoredMessage } from '../../src/shared/schemas/messages';
import { UpdateController, type UpdaterBackend } from '../../src/main/app/updater';
import { writeExport } from '../../src/main/app/dataExport';
import { cleanRuleLists } from '../../src/main/permissions/rules';

class FakeBackend implements UpdaterBackend {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  installed: Array<[boolean | undefined, boolean | undefined]> = [];
  checks = 0;
  private readonly listeners = new Map<string, Array<(arg: unknown) => void>>();
  constructor(private readonly onCheck: (backend: FakeBackend) => void) {}
  on(event: string, listener: (arg: unknown) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  fire(event: string, arg?: unknown): void {
    for (const l of this.listeners.get(event) ?? []) l(arg);
  }
  checkForUpdates(): Promise<unknown> {
    this.checks++;
    this.onCheck(this);
    return Promise.resolve(null);
  }
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.installed.push([isSilent, isForceRunAfter]);
  }
}

function controller(options: { enabled: boolean; supported: boolean; onCheck?: (b: FakeBackend) => void }) {
  const states: UpdateState[] = [];
  let enabled = options.enabled;
  const backend = new FakeBackend(options.onCheck ?? (() => undefined));
  const updates = new UpdateController({
    enabled: () => enabled,
    support: () => (options.supported ? { ok: true } : { ok: false, reason: 'No feed.' }),
    loadBackend: () => Promise.resolve(backend),
    emit: (s) => states.push(s),
    log: () => undefined,
    now: () => 1_000
  });
  return { updates, backend, states, setEnabled: (on: boolean) => (enabled = on) };
}

describe('update controller', () => {
  afterEach(() => vi.useRealTimers());

  it('stays off or unsupported without touching the updater', async () => {
    const off = controller({ enabled: false, supported: true });
    expect(off.updates.get().status).toBe('off');
    expect((await off.updates.check()).status).toBe('off');
    expect(off.backend.checks).toBe(0);

    const unsupported = controller({ enabled: true, supported: false });
    expect(unsupported.updates.get()).toMatchObject({ status: 'unsupported', message: 'No feed.' });
    expect(() => unsupported.updates.install()).toThrow(/No update is ready/);
  });

  it('walks checking → downloading → ready and installs on request', async () => {
    const c = controller({
      enabled: true,
      supported: true,
      onCheck: (b) => {
        b.fire('checking-for-update');
        b.fire('update-available', { version: '0.2.0' });
        b.fire('download-progress', { percent: 42.5 });
      }
    });
    expect(c.updates.get().status).toBe('idle');
    const state = await c.updates.check();
    expect(state).toMatchObject({ status: 'downloading', version: '0.2.0', progress: 42.5 });
    expect(c.backend.autoDownload).toBe(true);
    expect(c.backend.autoInstallOnAppQuit).toBe(true);
    // A second check while downloading doesn't start another one.
    await c.updates.check();
    expect(c.backend.checks).toBe(1);
    c.backend.fire('update-downloaded', { version: '0.2.0' });
    expect(c.updates.get()).toMatchObject({ status: 'ready', version: '0.2.0', progress: 100 });
    c.updates.install();
    expect(c.backend.installed).toEqual([[false, true]]);
    expect(c.states.map((s) => s.status)).toEqual(['checking', 'checking', 'downloading', 'downloading', 'ready']);
  });

  it('reports errors and "up to date", and stops installing on quit once turned off', async () => {
    const failing = controller({ enabled: true, supported: true, onCheck: (b) => b.fire('error', new Error('feed unreachable')) });
    expect(await failing.updates.check()).toMatchObject({ status: 'error', message: 'feed unreachable', checkedAt: 1_000 });

    // Nothing published yet (or a releases page that isn't public) is "up to date", not a failure.
    const unpublished = controller({ enabled: true, supported: true, onCheck: (b) => b.fire('error', new Error('HttpError: 404 Not Found "No published versions on GitHub"')) });
    expect(await unpublished.updates.check()).toMatchObject({ status: 'none', message: null, checkedAt: 1_000 });

    const current = controller({ enabled: true, supported: true, onCheck: (b) => b.fire('update-not-available', { version: '0.1.0' }) });
    expect(await current.updates.check()).toMatchObject({ status: 'none', checkedAt: 1_000 });
    expect(current.backend.autoInstallOnAppQuit).toBe(true);
    current.setEnabled(false);
    current.updates.sync();
    expect(current.updates.get().status).toBe('off');
    expect(current.backend.autoInstallOnAppQuit).toBe(false);
  });

  it('schedules the first background check and clears timers when disposed', () => {
    vi.useFakeTimers();
    const c = controller({ enabled: true, supported: true });
    c.updates.sync();
    expect(vi.getTimerCount()).toBe(2);
    c.updates.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});

function summary(id: string, incognito = false): SessionSummary {
  return { id, incognito, title: id } as unknown as SessionSummary;
}

describe('data export', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('writes settings, projects and saved sessions with messages, without incognito chats or keys', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-export-'));
    dirs.push(dir);
    const file = path.join(dir, 'export.json');
    const messages: Record<string, StoredMessage[]> = { a: [{ id: 'm1', role: 'user' } as unknown as StoredMessage], b: [] };
    const count = await writeExport(file, {
      version: '9.9.9',
      settings: { profile: { name: 'Ada' } },
      providers: [{ id: 'p1', kind: 'anthropic', label: 'Work' }],
      projects: [{ path: '/repo' }],
      schedules: [],
      sessions: () => [summary('a'), summary('secret', true), summary('b')],
      messages: (id) => messages[id] ?? []
    });
    expect(count).toBe(2);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { format: string; appVersion: string; sessions: Array<{ id: string; messages: unknown[] }> };
    expect(parsed.format).toBe('graft-export');
    expect(parsed.appVersion).toBe('9.9.9');
    expect(parsed.sessions.map((s) => s.id)).toEqual(['a', 'b']);
    expect(parsed.sessions[0]?.messages).toHaveLength(1);
    expect(fs.existsSync(`${file}.partial`)).toBe(false);
  });

  it('leaves no partial file behind when reading a session fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-export-'));
    dirs.push(dir);
    const file = path.join(dir, 'export.json');
    await expect(
      writeExport(file, {
        version: '1',
        settings: {},
        providers: [],
        projects: [],
        schedules: [],
        sessions: () => [summary('a')],
        messages: () => {
          throw new Error('disk error');
        }
      })
    ).rejects.toThrow('disk error');
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(`${file}.partial`)).toBe(false);
  });
});

describe('rule lists from Settings', () => {
  it('trims, drops blanks and duplicates, and reports invalid rules', () => {
    const { lists, invalid } = cleanRuleLists({ allow: [' Shell(npm test:*) ', 'Shell(npm test:*)', ''], ask: ['Edit(src/**)'], deny: ['not a rule!', 'Read(.env)'] }, 'user');
    expect(lists).toEqual({ allow: ['Shell(npm test:*)'], ask: ['Edit(src/**)'], deny: ['not a rule!', 'Read(.env)'] });
    expect(invalid).toEqual(['not a rule!']);
  });
});

describe('keep computer awake', () => {
  it('holds one blocker while any opted-in session works, and releases it when they stop', async () => {
    const { KeepAwake } = await import('../../src/main/app/keepAwake');
    const started: number[] = [];
    const stopped: number[] = [];
    let next = 1;
    const keep = new KeepAwake({ start: () => (started.push(next), next++), stop: (id) => stopped.push(id) });
    keep.status('a', 'running');
    expect(keep.active).toBe(false);
    keep.set('a', true);
    expect(keep.active).toBe(true);
    keep.set('b', true);
    keep.status('b', 'needs-input');
    expect(started).toEqual([1]);
    keep.status('a', 'idle');
    expect(keep.active).toBe(true);
    keep.forget('b');
    expect(keep.active).toBe(false);
    expect(stopped).toEqual([1]);
    expect(keep.list()).toEqual(['a']);
    keep.status('a', 'running');
    keep.dispose();
    expect(stopped).toEqual([1, 2]);
  });
});
