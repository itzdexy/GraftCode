import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { INTEGRATIONS } from '../../src/shared/integrations';
import { textOf, type ToolResultContent } from '../../src/shared/schemas/messages';
import { openDatabase, type Db } from '../../src/main/db/database';
import { findCommand, integrationSetup, integrationStatus } from '../../src/main/mcp/integrations';
import { McpManager } from '../../src/main/mcp/mcpManager';
import { SettingsStore } from '../../src/main/permissions/settingsStore';
import { KeyStore } from '../../src/main/secrets/keyStore';
import { ToolRegistry } from '../../src/main/tools/registry';
import { makeToolContext } from '../support/toolContext';
import { makeTempDir, removeDir } from '../support/tmp';

/**
 * Real MCP servers, started the way Graft starts them. Off by default: they
 * need the network, Node and uv, and download packages on first use.
 *
 *   GRAFT_LIVE_MCP=1 npx vitest run tests/unit/mcp.live.test.ts
 */
const enabled = process.env.GRAFT_LIVE_MCP === '1';
const SLOW = 240_000;

let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

function setup(servers: Record<string, unknown>): { manager: McpManager; registry: ToolRegistry; db: Db } {
  const home = makeTempDir();
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ mcpServers: servers }));
  const db = openDatabase(path.join(home, 'graft.db'));
  const keys = new KeyStore(db, { isEncryptionAvailable: () => true, encryptString: (t) => Buffer.from(t), decryptString: (b) => b.toString() }, () => false);
  const registry = new ToolRegistry();
  const manager = new McpManager({ settings: new SettingsStore(home), registry, keys, openBrowser: () => Promise.resolve(), log: () => undefined, onChange: () => undefined, version: '0.0.0-live-test' });
  cleanup.push(async () => {
    await manager.disposeAll();
    db.close();
    removeDir(home);
  });
  return { manager, registry, db };
}

/** The server config the one-click integration writes, as the settings file holds it. */
function fromCatalogue(id: string, values: Record<string, string> = {}): Record<string, unknown> {
  const { config } = integrationSetup(id, values, process.platform, process.env);
  return config.type === 'stdio' ? { type: 'stdio', command: config.command, args: config.args, env: config.env } : { type: 'http', url: config.url, headers: config.headers };
}

async function call(registry: ToolRegistry, name: string, input: unknown): Promise<{ isError: boolean; text: string }> {
  const tool = registry.get(name) as unknown as { execute(input: unknown, ctx: ReturnType<typeof makeToolContext>): Promise<{ isError: boolean; content: ToolResultContent[] }> } | undefined;
  if (!tool) throw new Error(`${name} is not registered. Registered: ${registry.names().join(', ')}`);
  const dir = makeTempDir();
  try {
    const result = await tool.execute(input, makeToolContext(dir));
    return { isError: result.isError, text: textOf(result.content) };
  } finally {
    removeDir(dir);
  }
}

describe.skipIf(!enabled)('real MCP servers through Graft’s MCP manager', () => {
  it(
    'starts the reference server with npx, lists its tools and calls one',
    async () => {
      const npx = findCommand('npx', process.platform, process.env);
      expect(npx, 'npx was not found: install Node.js').not.toBeNull();
      const { manager, registry } = setup({ everything: { type: 'stdio', command: npx, args: ['-y', '@modelcontextprotocol/server-everything'] } });
      await manager.sync();
      const [status] = manager.status();
      expect(status, JSON.stringify(status)).toMatchObject({ name: 'everything', state: 'connected', error: null });
      const tools = status!.tools.map((t) => t.registeredAs);
      expect(tools).toContain('mcp__everything__echo');
      const echoed = await call(registry, 'mcp__everything__echo', { message: 'graft says hello' });
      expect(echoed.isError).toBe(false);
      expect(echoed.text).toContain('graft says hello');
      console.info(`[live] everything: ${String(tools.length)} tools: ${tools.join(', ')}`);
      // What the real server publishes besides tools: resources the agent can read, and prompts that become commands.
      expect(status!.resources).toBe(true);
      expect(status!.prompts.length).toBeGreaterThan(0);
      const listed = await call(registry, 'mcp__resources__list', {});
      expect(listed.isError, listed.text).toBe(false);
      const uri = /\b[a-z][a-z0-9+.-]*:\/\/\S+/i.exec(listed.text)?.[0];
      expect(uri, listed.text.slice(0, 300)).toBeDefined();
      const read = await call(registry, 'mcp__resources__read', { server: 'everything', uri: uri! });
      expect(read.isError, read.text).toBe(false);
      expect(read.text.length).toBeGreaterThan(0);
      const prompt = status!.prompts[0]!;
      const filled = await manager.getPrompt('everything', prompt.name, Object.fromEntries(prompt.arguments.map((a) => [a.name, 'test'])));
      expect(filled.text.length).toBeGreaterThan(0);
      console.info(`[live] everything: resources readable (${uri!}); ${String(status!.prompts.length)} prompts, e.g. /${prompt.name}`);
    },
    SLOW
  );

  it(
    'starts the Playwright browser integration exactly as the catalogue sets it up, and gets its tools',
    async () => {
      const { manager } = setup({ playwright: fromCatalogue('playwright') });
      await manager.sync();
      const [status] = manager.status();
      expect(status, JSON.stringify(status)).toMatchObject({ name: 'playwright', state: 'connected', error: null });
      const tools = status!.tools.map((t) => t.name);
      expect(tools).toContain('browser_navigate');
      expect(tools.length).toBeGreaterThan(5);
      console.info(`[live] playwright: ${String(tools.length)} tools: ${tools.join(', ')}`);
    },
    SLOW
  );

  it(
    'connects to Context7 over HTTP without a key, as the catalogue sets it up, and looks a library up',
    async () => {
      const { manager, registry } = setup({ context7: fromCatalogue('context7') });
      await manager.sync();
      const [status] = manager.status();
      expect(status, JSON.stringify(status)).toMatchObject({ name: 'context7', state: 'connected', error: null });
      const tools = status!.tools.map((t) => t.name);
      expect(tools.length).toBeGreaterThan(0);
      console.info(`[live] context7: ${String(tools.length)} tools: ${tools.join(', ')}`);
      const resolve = status!.tools.find((t) => t.name.includes('resolve'));
      expect(resolve, 'Context7 no longer has a tool that resolves a library name').toBeDefined();
      const found = await call(registry, resolve!.registeredAs, { libraryName: 'react', query: 'How do I use the useEffect hook?' });
      expect(found.isError, found.text.slice(0, 400)).toBe(false);
      expect(found.text.toLowerCase()).toContain('react');
    },
    SLOW
  );
});

/**
 * The local integrations this computer is ready for (the runtime is installed,
 * and the app's own launcher where there is one), minus those that need a
 * value typed in. GRAFT_LIVE_MCP_ONLY=blender,godot narrows it down.
 */
const only = (process.env.GRAFT_LIVE_MCP_ONLY ?? '').split(',').filter((id) => id.length > 0);
const ready = enabled
  ? integrationStatus(process.platform, process.env)
      .filter((status) => status.blocker === null)
      .flatMap((status) => INTEGRATIONS.filter((i) => i.id === status.id))
      .filter((i) => (i.launch.win32 ?? i.launch.darwin ?? i.launch.linux)?.type === 'stdio' && !(i.fields ?? []).some((f) => !f.optional))
      .filter((i) => only.length === 0 || only.includes(i.id))
      .map((i) => i.id)
  : [];

describe.skipIf(!enabled || ready.length === 0)('the local integrations this computer is ready for', () => {
  it.each(ready)(
    '%s starts the way the catalogue sets it up and offers its tools',
    async (id) => {
      const integration = INTEGRATIONS.find((i) => i.id === id)!;
      const { manager } = setup({ [integration.serverName]: fromCatalogue(id) });
      await manager.sync();
      const [status] = manager.status();
      expect(status, JSON.stringify(status)).toMatchObject({ name: integration.serverName, state: 'connected', error: null });
      const tools = status!.tools.map((t) => t.name);
      console.info(`[live] ${id}: ${String(tools.length)} tools: ${tools.join(', ')}`);
      // Some servers only offer tools while the other app is open (Roblox Studio); connecting is what is checked here.
      expect(Array.isArray(tools)).toBe(true);
    },
    SLOW
  );
});

describe.skipIf(!enabled)('the integrations catalogue against the real world', () => {
  const stdio = INTEGRATIONS.flatMap((integration) => {
    const launch = integration.launch.linux ?? integration.launch.win32 ?? integration.launch.darwin;
    return launch?.type === 'stdio' && (launch.command === 'npx' || launch.command === 'uvx') ? [{ integration, launch }] : [];
  });

  /** The package a launch asks npx or uvx for: after --from when given, else the first argument that isn't a flag. */
  function packageOf(args: string[]): string {
    const from = args.indexOf('--from');
    const name = from !== -1 ? args[from + 1] : args.find((a) => !a.startsWith('-'));
    return (name ?? '').replace(/(?!^)@[^/]*$/, '');
  }

  it('reads the package out of each launch', () => {
    expect(stdio.map(({ integration, launch }) => [integration.id, launch.command, packageOf(launch.args)])).toEqual([
      ['blender', 'uvx', 'mcp-for-blender'],
      ['unity', 'uvx', 'mcpforunityserver'],
      ['godot', 'npx', '@coding-solo/godot-mcp'],
      ['playwright', 'npx', '@playwright/mcp'],
      ['ghidra', 'uvx', 'pyghidra-mcp']
    ]);
  });

  it.each(stdio.map(({ integration, launch }) => [integration.id, launch.command, packageOf(launch.args)] as const))(
    'the package behind %s exists where %s gets it (%s)',
    async (_id, command, name) => {
      const url = command === 'npx' ? `https://registry.npmjs.org/${name.replace('/', '%2F')}/latest` : `https://pypi.org/pypi/${name}/json`;
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      expect(response.status, `${url} answered ${String(response.status)}`).toBe(200);
      const body = (await response.json()) as { version?: string; info?: { version?: string } };
      console.info(`[live] ${name}: ${body.version ?? body.info?.version ?? 'unknown version'}`);
    },
    60_000
  );

  const remote = INTEGRATIONS.flatMap((integration) => {
    const launch = integration.launch.linux ?? integration.launch.win32 ?? integration.launch.darwin;
    return launch?.type === 'http' && !/^https?:\/\/(127\.0\.0\.1|localhost)/.test(launch.url) ? [[integration.id, launch.url] as const] : [];
  });

  it.each(remote)(
    'the %s server answers at %s',
    async (id, url) => {
      // An MCP request without credentials: a server that is there answers it, or says who may ask (401 or 403). Gone is 404, a wrong host fails to connect.
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'graft-live-test', version: '0' } } }),
        signal: AbortSignal.timeout(30_000)
      });
      console.info(`[live] ${id}: HTTP ${String(response.status)}`);
      expect([200, 202, 400, 401, 403, 405, 406], `${url} answered ${String(response.status)}`).toContain(response.status);
    },
    60_000
  );
});
