import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type * as ChildProcessModule from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageServers } from '../../src/main/languages/servers';
import { semanticCodeTool } from '../../src/main/tools/search/semantic';
import { makeTempDir, removeDir } from '../support/tmp';
import { makeToolContext } from '../support/toolContext';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}

let dir: string;
let servers: LanguageServers;
beforeEach(() => {
  dir = makeTempDir(); servers = new LanguageServers();
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'commonjs' } }));
  fs.writeFileSync(path.join(dir, 'library.ts'), 'export function twice(value: number): number { return value * 2; }\n');
  fs.writeFileSync(path.join(dir, 'main.ts'), 'import { twice as double } from "./library";\nexport const answer = double(21);\nexport function shadow() { const double = "unrelated"; return double; }\n');
});
afterEach(async () => { await servers.dispose(); removeDir(dir); });

describe('real TypeScript language-server queries', () => {
  it.skipIf(process.platform !== 'win32').each(['active', 'evicted'] as const)('awaits owned descendants before resolving Windows server disposal (%s client)', async (state) => {
    const actual = await vi.importActual<typeof ChildProcessModule>('node:child_process');
    const pidFile = path.join(dir, 'owned-child.pid');
    // A real protocol server whose child deliberately survives shutdown models
    // tsserver's asynchronous kill and the wrapper's forced-exit path. Its child
    // inherits the project cwd, which Windows keeps locked until that child exits.
    const fixture = `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      const { createMessageConnection } = require(${JSON.stringify(require.resolve('vscode-jsonrpc/node'))});
      const owned = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(owned.pid));
      const connection = createMessageConnection(process.stdin, process.stdout);
      connection.onRequest('initialize', () => ({ capabilities: {} }));
      connection.onRequest('textDocument/documentSymbol', () => []);
      connection.onRequest('shutdown', () => new Promise(() => {}));
      connection.onNotification('exit', () => {});
      connection.listen();
    `;
    let wrapperPid: number | undefined;
    vi.mocked(spawn).mockImplementationOnce((command, _args, options) => {
      const child = actual.spawn(command, ['-e', fixture], options ?? {});
      wrapperPid = child.pid;
      return child;
    });
    let ownedPid: number | undefined;
    try {
      await servers.query(dir, { action: 'outline', file: 'library.ts' }, new AbortController().signal);
      ownedPid = Number(fs.readFileSync(pidFile, 'utf8'));
      expect(processAlive(ownedPid)).toBe(true);
      if (state === 'evicted') {
        // Two quick, real protocol wrappers evict the hung first client. They
        // finish before its shutdown deadline, so disposal must also await the
        // retired client rather than only those still in the two-client cache.
        const quickFixture = `
          const { createMessageConnection } = require(${JSON.stringify(require.resolve('vscode-jsonrpc/node'))});
          const connection = createMessageConnection(process.stdin, process.stdout);
          connection.onRequest('initialize', () => ({ capabilities: {} }));
          connection.onRequest('textDocument/documentSymbol', () => []);
          connection.onRequest('shutdown', () => null);
          connection.onNotification('exit', () => process.exit(0));
          connection.listen();
        `;
        for (const name of ['second', 'third']) {
          const project = path.join(dir, name); fs.mkdirSync(project);
          fs.writeFileSync(path.join(project, 'library.ts'), 'export const value = 1;');
          vi.mocked(spawn).mockImplementationOnce((command, _args, options) => actual.spawn(command, ['-e', quickFixture], options ?? {}));
          await servers.query(project, { action: 'outline', file: 'library.ts' }, new AbortController().signal);
        }
        expect(processAlive(wrapperPid!)).toBe(true);
      }
      await servers.dispose();
      expect(processAlive(wrapperPid!)).toBe(false);
      expect(processAlive(ownedPid)).toBe(false);
    } finally {
      // Cleanup only this fixture's recorded child when testing the old bug.
      if (ownedPid && processAlive(ownedPid)) {
        process.kill(ownedPid);
        const deadline = Date.now() + 5000;
        while (processAlive(ownedPid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  });

  it('resolves imported aliases, tracks references without conflating shadowed variables, and reports types', async () => {
    const signal = new AbortController().signal;
    const definition = await servers.query(dir, { action: 'definition', file: 'main.ts', line: 2, column: 23 }, signal);
    expect(definition.locations).toContainEqual({ file: 'library.ts', line: 1, column: 17 });
    const refs = await servers.query(dir, { action: 'references', file: 'main.ts', line: 2, column: 23 }, signal);
    expect(refs.locations?.some((loc) => loc.file === 'main.ts' && loc.line === 2)).toBe(true);
    expect(refs.locations?.some((loc) => loc.file === 'main.ts' && loc.line === 3)).toBe(false);
    const hover = await servers.query(dir, { action: 'hover', file: 'main.ts', line: 2, column: 23 }, signal);
    expect(hover.hover).toContain('number');
    const outline = await servers.query(dir, { action: 'outline', file: 'library.ts' }, signal);
    expect(outline.symbols?.some((item) => item.name === 'twice')).toBe(true);
  }, 30_000);

  it('refreshes current diagnostics after file changes and never reuses the old clean result', async () => {
    const signal = new AbortController().signal;
    const before = await servers.query(dir, { action: 'diagnostics', file: 'main.ts' }, signal);
    expect(before.diagnostics?.filter((d) => d.severity === 1)).toEqual([]);
    fs.writeFileSync(path.join(dir, 'main.ts'), 'export const answer: number = "wrong";\n');
    const broken = await servers.query(dir, { action: 'diagnostics', file: 'main.ts' }, signal);
    expect(broken.diagnostics?.some((d) => d.code === 2322 && d.file === 'main.ts' && d.line === 1 && d.severity === 1)).toBe(true);
    fs.writeFileSync(path.join(dir, 'main.ts'), 'export const answer: number = 42;\n');
    const fixed = await servers.query(dir, { action: 'diagnostics', file: 'main.ts' }, signal);
    expect(fixed.diagnostics?.filter((d) => d.severity === 1)).toEqual([]);
  }, 60_000);

  it('requires project trust, rejects outside paths and respects pre-cancellation', async () => {
    const tool = semanticCodeTool(servers);
    const result = await tool.execute({ action: 'outline', file: 'library.ts' }, makeToolContext(dir));
    expect(result.isError).toBe(true);
    expect(result.content[0]?.type === 'text' ? result.content[0].text : '').toContain('trusted');
    await expect(servers.query(dir, { action: 'outline', file: process.execPath }, new AbortController().signal)).rejects.toMatchObject({ code: 'language_path' });
    const controller = new AbortController(); controller.abort();
    await expect(servers.query(dir, { action: 'outline', file: 'library.ts' }, controller.signal)).rejects.toThrow();
  });

  it('checks unsaved buffers without writing them and restores disk content for agent queries', async () => {
    const signal = new AbortController().signal;
    const original = fs.readFileSync(path.join(dir, 'main.ts'), 'utf8');
    const broken = await servers.query(dir, { action: 'diagnostics', file: 'main.ts' }, signal, 'export const answer: number = "draft";');
    expect(broken.diagnostics?.some((d) => d.code === 2322)).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'main.ts'), 'utf8')).toBe(original);
    const disk = await servers.query(dir, { action: 'diagnostics', file: 'main.ts' }, signal);
    expect(disk.diagnostics?.filter((d) => d.severity === 1)).toEqual([]);
    await servers.query(dir, { action: 'outline', file: 'library.ts' }, signal, 'export function twice(value: string): string { return value; }');
    const importedDisk = await servers.query(dir, { action: 'diagnostics', file: 'main.ts' }, signal);
    expect(importedDisk.diagnostics?.filter((d) => d.severity === 1)).toEqual([]);
    await expect(servers.query(dir, { action: 'outline', file: 'main.ts' }, signal, 'x'.repeat(2 * 1024 * 1024 + 1))).rejects.toMatchObject({ code: 'language_file_limit' });
  }, 30_000);

  it('isolates same-named files in separate projects and cancels initialization without poisoning later queries', async () => {
    const other = path.join(dir, 'other'); fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'library.ts'), 'export const distinct = true;\n');
    const controller = new AbortController();
    const cancelled = servers.query(dir, { action: 'outline', file: 'library.ts' }, controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: 'interrupted' });
    const signal = new AbortController().signal;
    const [first, second] = await Promise.all([
      servers.query(dir, { action: 'outline', file: 'library.ts' }, signal),
      servers.query(other, { action: 'outline', file: 'library.ts' }, signal)
    ]);
    expect(first.symbols?.map((s) => s.name)).toContain('twice');
    expect(second.symbols?.map((s) => s.name)).toEqual(['distinct']);
  }, 30_000);

  it('does not load a project-local tsserver plugin or accept paths through an external symlink', async () => {
    const plugin = path.join(dir, 'node_modules', 'graft-test-plugin'); fs.mkdirSync(plugin, { recursive: true });
    const marker = path.join(dir, 'plugin-ran.txt');
    fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({ name: 'graft-test-plugin', main: 'index.js' }));
    fs.writeFileSync(path.join(plugin, 'index.js'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); module.exports = () => ({ create: info => info.languageService });`);
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { plugins: [{ name: 'graft-test-plugin' }] } }));
    await servers.query(dir, { action: 'outline', file: 'library.ts' }, new AbortController().signal);
    expect(fs.existsSync(marker)).toBe(false);
    const external = makeTempDir();
    try {
      fs.writeFileSync(path.join(external, 'outside.ts'), 'export const external = 1;');
      fs.symlinkSync(external, path.join(dir, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
      await expect(servers.query(dir, { action: 'outline', file: 'link/outside.ts' }, new AbortController().signal)).rejects.toMatchObject({ code: 'language_path' });
    } finally { fs.rmSync(path.join(dir, 'link'), { force: true }); removeDir(external); }
  }, 30_000);
});
