import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nextZoom, type PageSnapshot } from '../../src/main/browser/browserPanel';
import { localServers, portOpen } from '../../src/main/browser/servers';
import { locate } from '../../src/main/browser/pageScripts';
import { decide, isLocalUrl, type PermissionEnv } from '../../src/main/permissions/engine';
import { sandboxUrl } from '../../src/main/sandbox/sandbox';
import { browserTool, formatSnapshot } from '../../src/main/tools/browserTool';
import type { AgentBrowser } from '../../src/main/tools/types';
import { makeTempDir } from '../support/tmp';
import { makeToolContext } from '../support/toolContext';

const page: PageSnapshot = {
  title: 'Sign up',
  url: 'http://localhost:5173/',
  text: 'Create your account\nName\nEmail',
  truncated: false,
  items: [
    { ref: 1, role: 'input[text]', label: 'Name', selector: '#name', value: '' },
    { ref: 2, role: 'input[checkbox]', label: 'Remember me', selector: '#remember', checked: true },
    { ref: 3, role: 'button', label: 'Create account', selector: 'form > button', disabled: true }
  ]
};

describe('browser panel helpers', () => {
  it('zooms in steps and resets to 100%', () => {
    expect(nextZoom(1, 'in')).toBe(1.1);
    expect(nextZoom(1, 'out')).toBe(0.9);
    expect(nextZoom(2, 'in')).toBe(2);
    expect(nextZoom(0.5, 'out')).toBe(0.5);
    expect(nextZoom(1.33, 'in')).toBe(1.5);
    expect(nextZoom(1.75, 'reset')).toBe(1);
  });

  it('tells local addresses from the rest', () => {
    expect(isLocalUrl('http://localhost:5173')).toBe(true);
    expect(isLocalUrl('localhost:3000/docs')).toBe(true);
    expect(isLocalUrl('http://127.0.0.1:8080')).toBe(true);
    expect(isLocalUrl('http://[::1]:8000')).toBe(true);
    expect(isLocalUrl('http://app.localhost:3000')).toBe(true);
    expect(isLocalUrl('https://example.com')).toBe(false);
    expect(isLocalUrl('http://localhost.example.com')).toBe(false);
  });

  it('sends localhost to the port a sandbox forwards, and leaves everything else alone', () => {
    const ports = { 5173: 49153 };
    expect(sandboxUrl('http://localhost:5173/app?x=1', ports)).toBe('http://127.0.0.1:49153/app?x=1');
    expect(sandboxUrl('localhost:5173', ports)).toBe('http://127.0.0.1:49153/');
    expect(sandboxUrl('http://0.0.0.0:5173', ports)).toBe('http://127.0.0.1:49153/');
    expect(sandboxUrl('http://localhost:3000', ports)).toBe('http://localhost:3000');
    expect(sandboxUrl('https://example.com:5173', ports)).toBe('https://example.com:5173');
  });

  it('embeds what the agent typed as data, never as code', () => {
    const script = locate({ selector: '"); alert(1); ("' });
    expect(script).toContain(JSON.stringify({ selector: '"); alert(1); ("' }));
    expect(script).not.toContain('alert(1); ("\')');
  });
});

describe('dev server detection', () => {
  let server: http.Server;
  let port = 0;
  beforeAll(async () => {
    server = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('finds servers on the usual ports, and skips closed ones', async () => {
    expect(await portOpen(port, '127.0.0.1')).toBe(true);
    expect(await localServers([port])).toEqual([{ url: `http://localhost:${port}`, port }]);
    server.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await localServers([port])).toEqual([]);
  });
});

describe('Browser tool', () => {
  it('shows the model numbered elements, values and states, and points at console problems', () => {
    const text = formatSnapshot(page, 2, 1000);
    expect(text).toContain('Page: Sign up (http://localhost:5173/)');
    expect(text).toContain('[1] input[text] "Name"');
    expect(text).toContain('[2] input[checkbox] "Remember me" checked');
    expect(text).toContain('[3] button "Create account" disabled');
    expect(text).toContain('logged 2 errors or warnings');
    expect(text).toContain('Create your account');
    expect(formatSnapshot({ ...page, items: [] }, 0, 1000)).toContain('No links, buttons or fields are visible.');
  });

  const calls: string[] = [];
  const fake: AgentBrowser = {
    open: (url) => {
      calls.push(`open ${url}`);
      return Promise.resolve(url);
    },
    snapshot: () => Promise.resolve(page),
    capture: () => Promise.resolve({ mediaType: 'image/png', data: 'iVBORw0KGgo=', width: 800, height: 600 }),
    click: (target) => {
      calls.push(`click ${JSON.stringify(target)}`);
      return Promise.resolve('Create account');
    },
    type: (target, text, submit) => {
      calls.push(`type ${JSON.stringify(target)} ${text} ${submit}`);
      return Promise.resolve('Name');
    },
    press: () => Promise.resolve(),
    scroll: () => Promise.resolve(),
    back: () => Promise.resolve(),
    reload: () => Promise.resolve(),
    waitForText: (text) => Promise.resolve(text === 'Welcome'),
    console: () => [{ level: 'error', message: 'Uncaught TypeError: x is undefined', source: 'http://localhost:5173/app.js', line: 12, at: 0 }],
    currentUrl: () => page.url
  };
  const ctx = makeToolContext(makeTempDir(), { browser: fake });

  it('opens, clicks and types through the panel and answers with the updated page', async () => {
    const opened = await browserTool.execute({ action: 'open', url: 'http://localhost:5173' }, ctx);
    expect(opened.isError).toBe(false);
    expect(JSON.stringify(opened.content)).toContain('[1] input[text]');
    await browserTool.execute({ action: 'click', ref: 3 }, ctx);
    await browserTool.execute({ action: 'type', ref: 1, text: 'Ada', submit: true }, ctx);
    expect(calls).toEqual(['open http://localhost:5173', 'click {"ref":3}', 'type {"ref":1} Ada true']);
    const shot = await browserTool.execute({ action: 'screenshot' }, ctx);
    expect(shot.content.some((b) => b.type === 'image')).toBe(true);
    const log = await browserTool.execute({ action: 'console' }, ctx);
    expect(JSON.stringify(log.content)).toContain('[error] Uncaught TypeError: x is undefined (http://localhost:5173/app.js:12)');
  });

  it('explains what is missing instead of guessing', async () => {
    expect((await browserTool.execute({ action: 'click' }, ctx)).isError).toBe(true);
    expect((await browserTool.execute({ action: 'type', ref: 1 }, ctx)).isError).toBe(true);
    expect((await browserTool.execute({ action: 'open' }, ctx)).isError).toBe(true);
    const blind = await browserTool.execute({ action: 'screenshot' }, makeToolContext(makeTempDir(), { browser: fake, modelSupportsVision: false }));
    expect(JSON.stringify(blind.content)).toContain("can't see images");
    const late = await browserTool.execute({ action: 'wait', text: 'Never shows' }, ctx);
    expect(late.isError).toBe(true);
    expect((await browserTool.execute({ action: 'wait', text: 'Welcome' }, ctx)).isError).toBe(false);
    expect((await browserTool.execute({ action: 'read' }, makeToolContext(makeTempDir(), { browser: null }))).isError).toBe(true);
  });
});

describe('Browser permissions', () => {
  const env = (mode: PermissionEnv['mode']): PermissionEnv => ({ mode, projectRoot: '/proj', platform: 'linux', home: '/home/me', rules: { allow: [], ask: [], deny: [] } });
  const call = async (input: Parameters<typeof browserTool.describe>[0]) => ({
    toolName: 'Browser',
    permissionClass: browserTool.permissionClass,
    descriptor: await browserTool.describe(input, { cwd: '/proj', projectRoot: '/proj', platform: 'linux' })
  });

  it('opens local dev servers without asking in Auto-edit, and asks for other sites', async () => {
    expect(decide(await call({ action: 'open', url: 'http://localhost:5173' }), env('auto-edit')).behavior).toBe('allow');
    const remote = decide(await call({ action: 'open', url: 'https://example.com' }), env('auto-edit'));
    expect(remote.behavior).toBe('ask');
    expect(remote.suggestedRule).toBe('Browser(domain:example.com)');
    expect(decide(await call({ action: 'open', url: 'http://localhost:5173' }), env('ask')).behavior).toBe('ask');
  });

  it('works with the open page freely, but never clicks or types in Plan mode', async () => {
    expect(decide(await call({ action: 'read' }), env('ask')).behavior).toBe('allow');
    expect(decide(await call({ action: 'click', ref: 2 }), env('ask')).behavior).toBe('allow');
    expect(decide(await call({ action: 'read' }), env('plan')).behavior).toBe('allow');
    expect(decide(await call({ action: 'click', ref: 2 }), env('plan')).behavior).toBe('deny');
    expect(decide(await call({ action: 'type', ref: 1, text: 'x' }), env('plan')).behavior).toBe('deny');
  });
});
