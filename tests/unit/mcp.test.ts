import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../../src/main/db/database';
import { maskConfig, mergeMcpConfig } from '../../src/main/mcp/mcpConfig';
import { convertContent, McpManager, mcpToolName, progressLine, stdioEnv, troubleshootFor } from '../../src/main/mcp/mcpManager';
import { SettingsStore } from '../../src/main/permissions/settingsStore';
import { KeyStore } from '../../src/main/secrets/keyStore';
import { ToolRegistry } from '../../src/main/tools/registry';
import { makeToolContext } from '../support/toolContext';
import { makeTempDir, removeDir } from '../support/tmp';

const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'mcp-test-server.mjs');
const LATE = path.resolve(__dirname, '..', 'fixtures', 'mcp-late-server.mjs');

/** Polls until `check` holds (servers answer on their own schedule). */
async function eventually(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

type Executable = { execute(input: unknown, c: ReturnType<typeof makeToolContext>): Promise<{ isError: boolean; content: unknown }> };

let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

function setup(servers: Record<string, unknown>): { manager: McpManager; registry: ToolRegistry; home: string; db: Db } {
  const home = makeTempDir();
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ mcpServers: servers }));
  const db = openDatabase(path.join(home, 'graft.db'));
  const keys = new KeyStore(db, { isEncryptionAvailable: () => true, encryptString: (t) => Buffer.from(t), decryptString: (b) => b.toString() }, () => false);
  const registry = new ToolRegistry();
  const manager = new McpManager({
    settings: new SettingsStore(home),
    registry,
    keys,
    openBrowser: () => Promise.resolve(),
    log: () => undefined,
    onChange: () => undefined,
    version: '0.0.0-test',
    timings: { toolPollMs: 200, reconnectDelaysMs: [100] }
  });
  cleanup.push(async () => {
    await manager.disposeAll();
    db.close();
    removeDir(home);
  });
  return { manager, registry, home, db };
}

describe('MCP manager', () => {
  it('connects a stdio server, registers namespaced tools and calls them', async () => {
    const { manager, registry } = setup({ test: { type: 'stdio', command: process.execPath, args: [FIXTURE] } });
    await manager.sync();
    const [status] = manager.status();
    expect(status).toMatchObject({ name: 'test', state: 'connected', error: null });
    expect(status?.tools.map((t) => [t.registeredAs, t.readOnly])).toEqual([
      ['mcp__test__shout', true],
      ['mcp__test__save_note', false]
    ]);
    expect(manager.toolNames(null)).toEqual(['mcp__test__shout', 'mcp__test__save_note']);

    const shout = registry.get('mcp__test__shout');
    expect(shout?.mcp).toEqual({ server: 'test', tool: 'shout', readOnly: true, destructive: false });
    // The server's own JSON Schema is what models see.
    expect(registry.specs(['mcp__test__shout'])[0]?.inputSchema).toMatchObject({ type: 'object', properties: { text: { type: 'string' } } });

    const dir = makeTempDir();
    const ctx = makeToolContext(dir);
    const result = await (shout as unknown as { execute(input: unknown, c: typeof ctx): Promise<{ isError: boolean; content: unknown; display: unknown }> }).execute({ text: 'quiet' }, ctx);
    expect(result).toMatchObject({ isError: false, content: [{ type: 'text', text: 'QUIET' }], display: { kind: 'mcp', server: 'test', tool: 'shout', text: 'QUIET' } });
    removeDir(dir);
  });

  it('disconnects and unregisters tools when a server is disabled', async () => {
    const { manager, registry, home } = setup({ test: { type: 'stdio', command: process.execPath, args: [FIXTURE] } });
    await manager.sync();
    expect(registry.get('mcp__test__shout')).toBeDefined();
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ mcpServers: { test: { type: 'stdio', command: process.execPath, args: [FIXTURE], enabled: false } } }));
    await manager.sync();
    expect(manager.status()[0]?.state).toBe('disabled');
    expect(registry.get('mcp__test__shout')).toBeUndefined();
    expect(manager.toolNames(null)).toEqual([]);
  });

  it('reports servers that fail to start', async () => {
    const { manager } = setup({ broken: { type: 'stdio', command: path.join(makeTempDir(), 'no-such-binary'), args: [] } });
    await manager.sync();
    expect(manager.status()[0]).toMatchObject({ name: 'broken', state: 'failed' });
    expect(manager.status()[0]?.error).toBeTruthy();
  });

  it('only exposes a project’s own servers to sessions in that project, and only when trusted', async () => {
    const { manager } = setup({});
    const project = makeTempDir();
    fs.mkdirSync(path.join(project, '.graft'));
    fs.writeFileSync(path.join(project, '.graft', 'settings.json'), JSON.stringify({ mcpServers: { local: { type: 'stdio', command: process.execPath, args: [FIXTURE] } } }));
    await manager.useProject(project, false);
    expect(manager.status()).toEqual([]);
    await manager.useProject(project, true);
    expect(manager.status()[0]).toMatchObject({ name: 'local', scope: 'project', projectRoot: project, state: 'connected' });
    expect(manager.toolNames(project)).toContain('mcp__local__shout');
    expect(manager.toolNames(null)).toEqual([]);
    expect(manager.toolNames(makeTempDir())).toEqual([]);
    // The server runs in the project folder; stop it before removing the folder (Windows locks it).
    await manager.disposeAll();
    removeDir(project);
  });
});

describe('MCP servers that change after connecting', () => {
  it('picks up tools a server announces after connecting (Roblox Studio’s proxy works this way)', async () => {
    const { manager, registry } = setup({ late: { type: 'stdio', command: process.execPath, args: [LATE, 'late'] } });
    await manager.sync();
    // Connected, but nothing yet: the status says so instead of looking broken.
    expect(manager.status()[0]).toMatchObject({ state: 'connected', tools: [] });
    expect(manager.status()[0]?.hint).toMatch(/no tools yet/);
    await eventually(() => registry.get('mcp__late__ping') !== undefined);
    expect(manager.status()[0]?.tools.map((t) => t.name)).toEqual(['ping', 'render']);
    expect(manager.status()[0]?.hint).toBeNull();
  });

  it('asks again when a server’s tools appear without an announcement', async () => {
    const { manager, registry } = setup({ silent: { type: 'stdio', command: process.execPath, args: [LATE, 'silent'] } });
    await manager.sync();
    expect(manager.toolNames(null)).toEqual([]);
    await eventually(() => registry.get('mcp__silent__ping') !== undefined);
  });

  it('shows a long call’s progress as it runs', async () => {
    const { manager, registry } = setup({ late: { type: 'stdio', command: process.execPath, args: [LATE, 'crash'] } });
    await manager.sync();
    const ctx = makeToolContext(makeTempDir());
    const result = await (registry.get('mcp__late__render') as unknown as Executable).execute({}, ctx);
    expect(result).toMatchObject({ isError: false, content: [{ type: 'text', text: 'rendered' }] });
    expect(ctx.progressChunks).toEqual(['Rendering · 25%\n', 'Rendering · 50%\n', 'Rendering · 75%\n']);
  });

  it('reconnects a server that stopped by itself', async () => {
    const { manager, registry } = setup({ flaky: { type: 'stdio', command: process.execPath, args: [LATE, 'crash'] } });
    await manager.sync();
    const ctx = makeToolContext(makeTempDir());
    await (registry.get('mcp__flaky__ping') as unknown as Executable).execute({}, ctx);
    // The server exits after answering; Graft notices, reconnects, and the tools come back.
    await eventually(() => manager.status()[0]?.state !== 'connected');
    await eventually(() => manager.status()[0]?.state === 'connected' && registry.get('mcp__flaky__ping') !== undefined);
    expect(manager.status()[0]?.error).toBeNull();
  });
});

describe('MCP helpers', () => {
  it('writes progress as a short line', () => {
    expect(progressLine({ progress: 1, total: 4, message: 'Rendering' })).toBe('Rendering · 25%\n');
    expect(progressLine({ progress: 3 })).toBe('Working…\n');
  });

  it('gives stdio servers this computer’s environment, with the usual install folders on PATH', () => {
    const env = stdioEnv({ PATH: '/usr/bin', HOME: '/home/me', SECRET_HELPER: 'x' }, { TOKEN: 'abc' }, 'linux');
    expect(env.HOME).toBe('/home/me');
    expect(env.TOKEN).toBe('abc');
    expect(env.PATH?.split(':')[0]).toBe('/usr/bin');
    expect(env.PATH).toContain('/home/me/.local/bin');
    // A Windows PATH keeps its own key and separator.
    const win = stdioEnv({ Path: 'C:\\Windows', USERPROFILE: 'C:\\Users\\me', PATHEXT: '.EXE;.CMD' }, {}, 'win32');
    expect(win.Path?.startsWith('C:\\Windows;')).toBe(true);
    expect(win.PATHEXT).toBe('.EXE;.CMD');
  });

  it('knows what to check for the apps it integrates with', () => {
    expect(troubleshootFor('roblox_studio')).toMatch(/Enable Studio as MCP server/);
    expect(troubleshootFor('blender')).toMatch(/Blender is open/);
    expect(troubleshootFor('my-own-server')).toBeNull();
  });

  it('sanitizes and bounds tool names', () => {
    expect(mcpToolName('my-server', 'get.file')).toBe('mcp__my_server__get_file');
    const long = mcpToolName('s'.repeat(40), 't'.repeat(40));
    expect(long).toHaveLength(64);
    expect(long).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
    expect(mcpToolName('s'.repeat(40), 't'.repeat(40))).toBe(long);
  });

  it('converts tool result content, dropping images for models without vision', () => {
    const content = [
      { type: 'text', text: 'hi' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      { type: 'resource', resource: { uri: 'file:///a', text: 'body' } }
    ];
    expect(convertContent(content, true)).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'image', mediaType: 'image/png', data: 'AAAA' },
      { type: 'text', text: 'file:///a:\nbody' }
    ]);
    expect(convertContent(content, false)[1]).toEqual({ type: 'text', text: '[image image/png omitted]' });
    expect(convertContent([], false)).toEqual([{ type: 'text', text: '(no content)' }]);
  });

  it('masks secrets for the UI and keeps unchanged ones on save', () => {
    const stored = { type: 'stdio' as const, command: 'node', args: ['s.js'], env: { TOKEN: 'secret', OTHER: 'x' }, enabled: true };
    expect(maskConfig(stored)).toEqual({ type: 'stdio', command: 'node', args: ['s.js'], envKeys: ['TOKEN', 'OTHER'], cwd: null, enabled: true });
    const merged = mergeMcpConfig({ type: 'stdio', command: 'node', args: ['s.js'], env: { NEW: 'n' }, keepEnv: ['TOKEN'], cwd: null, enabled: true }, stored);
    expect(merged).toEqual({ type: 'stdio', command: 'node', args: ['s.js'], env: { TOKEN: 'secret', NEW: 'n' }, enabled: true });
  });
});
