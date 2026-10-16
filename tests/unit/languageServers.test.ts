import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type * as ChildProcessModule from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditChecks, problemsNote } from '../../src/main/languages/problems';
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

  it('finds a declaration by its name, the implementations of an interface and the declaration of a value’s type', async () => {
    const signal = new AbortController().signal;
    fs.writeFileSync(path.join(dir, 'shapes.ts'), [
      'export interface Shape { area(): number; }',
      'export class Square implements Shape { constructor(readonly side: number) {} area(): number { return this.side ** 2; } }',
      'export class Circle implements Shape { constructor(readonly radius: number) {} area(): number { return Math.PI * this.radius ** 2; } }',
      'export const unit: Shape = new Square(1);',
      'export function twiceTheArea(shape: Shape): number { return shape.area() * 2; }',
      ''
    ].join('\n'));
    // By name, from any file of the project: the name as asked first, then the names that begin with it.
    const byName = await servers.query(dir, { action: 'symbol', file: 'main.ts', name: 'twice' }, signal);
    expect(byName.symbols?.[0]).toMatchObject({ file: 'library.ts', line: 1, column: 17, name: 'twice' });
    expect(byName.symbols?.map((s) => s.name)).toContain('twiceTheArea');
    // The place it gives is the name itself, so the next question (who uses it?) can be asked there.
    const first = byName.symbols![0]!;
    const uses = await servers.query(dir, { action: 'references', file: first.file, line: first.line, column: first.column }, signal);
    expect(uses.locations?.some((l) => l.file === 'main.ts' && l.line === 2)).toBe(true);
    expect((await servers.query(dir, { action: 'symbol', file: 'main.ts', name: 'noSuchNameAnywhere' }, signal)).symbols).toEqual([]);
    await expect(servers.query(dir, { action: 'symbol', file: 'main.ts' }, signal)).rejects.toMatchObject({ code: 'language_name' });
    // Every class that implements the interface (asked on its name, line 1).
    const implementations = await servers.query(dir, { action: 'implementation', file: 'shapes.ts', line: 1, column: 18 }, signal);
    expect(implementations.locations?.map((l) => l.line).sort()).toEqual([2, 3]);
    // The type behind a value: `unit` is a Shape, declared on line 1.
    const type = await servers.query(dir, { action: 'typeDefinition', file: 'shapes.ts', line: 4, column: 14 }, signal);
    expect(type.locations).toContainEqual({ file: 'shapes.ts', line: 1, column: 18 });
  }, 60_000);

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

  it('gives the agent a symbol search it can read: kinds as words, the place on the name, how many were found', async () => {
    const tool = semanticCodeTool(servers);
    const ctx = makeToolContext(dir, { trustedProject: true });
    const input = { action: 'symbol' as const, file: 'main.ts', name: 'twice' };
    expect((await tool.describe(input, ctx)).summary).toBe('Semantic symbol: twice');
    const result = await tool.execute(input, ctx);
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(JSON.parse(text)).toMatchObject({ action: 'symbol', symbols: [{ file: 'library.ts', line: 1, column: 17, name: 'twice', kind: 'function' }] });
    expect(result.display).toMatchObject({ kind: 'grep', pattern: 'Semantic symbol: twice', count: 1 });
    // An outline says kinds in words as well.
    const outline = await tool.execute({ action: 'outline', file: 'library.ts' }, ctx);
    expect(outline.content[0]?.type === 'text' ? outline.content[0].text : '').toContain('"kind": "function"');
    // Without a name there is nothing to find, and the error says so instead of returning everything.
    const nameless = await tool.execute({ action: 'symbol', file: 'main.ts' }, ctx);
    expect(nameless.isError).toBe(true);
    expect(nameless.content[0]?.type === 'text' ? nameless.content[0].text : '').toContain('Give the name');
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

describe('an edited file checked by the real server', () => {
  const signal = new AbortController().signal;
  // Generous waits: the first query starts the server and loads the project.
  const check = (name: string) => new EditChecks(servers, { budgetMs: 60_000, pauseMs: 0 }).problemsIn(dir, path.join(dir, name), signal);
  const TWO_ARGUMENTS = 'export function twice(value: number, times: number): number { return value * times; }\n';

  it('reports the type error an edit introduced, in the form the edit tools pass on, and nothing once it is fixed', async () => {
    const file = path.join(dir, 'main.ts');
    expect(await check('main.ts')).toEqual({ source: 'TypeScript', problems: [], total: 0 });

    fs.writeFileSync(file, 'import { twice } from "./library";\nexport const answer: string = twice(21);\n');
    const broken = await check('main.ts');
    expect(broken?.total).toBe(1);
    expect(broken?.problems[0]).toMatchObject({ line: 2, column: 14, code: 2322 });
    expect(broken?.problems[0]?.text).toContain("Type 'number' is not assignable to type 'string'");
    expect(problemsNote('main.ts', broken!)).toContain('> 2:14  TS2322  ');

    fs.writeFileSync(file, 'import { twice } from "./library";\nexport const answer: number = twice(21);\n');
    expect((await check('main.ts'))?.total).toBe(0);
  }, 60_000);

  it('sees that a change to one file broke another, when that other file is checked', async () => {
    expect((await check('main.ts'))?.total).toBe(0);
    // The function now wants a second argument; the file that calls it did not change.
    fs.writeFileSync(path.join(dir, 'library.ts'), TWO_ARGUMENTS);
    expect((await check('library.ts'))?.total).toBe(0);
    const caller = await check('main.ts');
    expect(caller?.total).toBe(1);
    expect(caller?.problems[0]?.code).toBe(2554);
  }, 60_000);

  it('checks a file against what its imports hold on disk now, not the copy the server was given earlier', async () => {
    const library = path.join(dir, 'library.ts');
    const original = fs.readFileSync(library, 'utf8');
    // Both files are now documents the server holds open, and it answers from those.
    expect((await check('library.ts'))?.total).toBe(0);
    expect((await check('main.ts'))?.total).toBe(0);

    // A command, the user's editor or a rewind changes the library. Nobody asks about that file.
    fs.writeFileSync(library, TWO_ARGUMENTS);
    const caller = await check('main.ts');
    expect(caller?.total).toBe(1);
    expect(caller?.problems[0]?.code).toBe(2554);

    // Changed back the same way: the error goes with its cause instead of being reported for good.
    fs.writeFileSync(library, original);
    expect((await check('main.ts'))?.total).toBe(0);

    // Deleted: the file that imports it no longer finds it.
    fs.rmSync(library);
    const orphan = await check('main.ts');
    expect(orphan?.problems.map((p) => p.code)).toContain(2307);
  }, 60_000);
});
