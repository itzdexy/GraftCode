import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CodeIntel, findTypeScript, isCheckable } from '../../src/main/intel/codeIntel';
import { problemsNote, toProblems, type FileProblems } from '../../src/main/intel/problems';
import { readFrames } from '../../src/main/intel/tsProtocol';

/** One tsserver message as it arrives: a length header, a blank line, the JSON and a newline. */
function frame(message: unknown): Buffer {
  const body = `${JSON.stringify(message)}\n`;
  return Buffer.from(`Content-Length: ${String(Buffer.byteLength(body, 'utf8'))}\r\n\r\n${body}`, 'utf8');
}

describe('what a TypeScript server writes', () => {
  it('is read message by message, however the bytes are cut up', () => {
    const first = { seq: 0, type: 'response', request_seq: 1, success: true, body: [{ text: 'Größe ≠ size' }] };
    const second = { seq: 0, type: 'event', event: 'projectLoadingFinish' };
    const all = Buffer.concat([frame(first), frame(second)]);
    expect(readFrames(all)).toEqual({ messages: [first, second], rest: Buffer.alloc(0) });

    // Fed a few bytes at a time, with a cut inside a header, inside a two-byte character and between messages.
    const seen: unknown[] = [];
    let rest: Buffer = Buffer.alloc(0);
    for (let at = 0; at < all.length; at += 7) {
      const read = readFrames(Buffer.concat([rest, all.subarray(at, at + 7)]));
      seen.push(...read.messages);
      rest = read.rest;
    }
    expect(seen).toEqual([first, second]);
    expect(rest.length).toBe(0);
  });

  it('skips what is not a message and keeps reading', () => {
    const good = { type: 'response', request_seq: 2, success: true };
    const noisy = Buffer.concat([Buffer.from('Content-Length: 9\r\n\r\nnot json\n'), frame(good)]);
    expect(readFrames(noisy).messages).toEqual([good]);
    // A header that is not a length: everything up to the next header is dropped.
    expect(readFrames(Buffer.concat([Buffer.from('warning: deprecated\r\n\r\n'), frame(good)])).messages).toEqual([good]);
  });
});

describe('problems in a file', () => {
  const diagnostics = [
    { start: { line: 30, offset: 1 }, end: { line: 30, offset: 4 }, text: "Cannot find name 'foo'.", code: 2304, category: 'error' },
    { start: { line: 12, offset: 5 }, end: { line: 12, offset: 9 }, text: "Type 'string' is not assignable to type 'number'.\n  The expected type comes from property 'n'.", code: 2322, category: 'error' },
    { start: { line: 3, offset: 1 }, end: { line: 3, offset: 2 }, text: "'x' is declared but never used.", code: 6133, category: 'suggestion' },
    { start: { line: 4, offset: 1 }, end: { line: 4, offset: 2 }, text: 'Unreachable code detected.', code: 7027, category: 'warning' }
  ];

  it('are the errors, in the order of the file, each on one line', () => {
    expect(toProblems(diagnostics)).toEqual([
      { line: 12, column: 5, code: 2322, text: "Type 'string' is not assignable to type 'number'. The expected type comes from property 'n'." },
      { line: 30, column: 1, code: 2304, text: "Cannot find name 'foo'." }
    ]);
    expect(toProblems([])).toEqual([]);
    expect(toProblems([{ text: 'no position', code: 1, category: 'error' }])).toEqual([{ line: 1, column: 1, code: 1, text: 'no position' }]);
  });

  it('are told to the model with where each one is, and how many were left out', () => {
    const found: FileProblems = { source: 'TypeScript', problems: toProblems(diagnostics), total: 2 };
    expect(problemsNote('src/a.ts', found)).toBe(
      [
        'TypeScript reports 2 problems in src/a.ts as it is now:',
        "  12:5  TS2322  Type 'string' is not assignable to type 'number'. The expected type comes from property 'n'.",
        "  30:1  TS2304  Cannot find name 'foo'.",
        'Fix what this change caused. Problems that were there before can wait unless they are in your way.'
      ].join('\n')
    );
    expect(problemsNote('a.ts', { source: 'TypeScript', problems: found.problems.slice(0, 1), total: 14 })).toContain('…and 13 more.');
    expect(problemsNote('a.ts', { source: 'TypeScript', problems: found.problems.slice(0, 1), total: 1 })).toContain('reports 1 problem in a.ts');
  });
});

describe('the TypeScript a project brings', () => {
  let root: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-intel-find-'));
    fs.mkdirSync(path.join(root, 'node_modules', 'typescript', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'typescript', 'lib', 'tsserver.js'), '');
    fs.mkdirSync(path.join(root, 'packages', 'web', 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'packages', 'api', 'node_modules', 'typescript', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(root, 'packages', 'api', 'node_modules', 'typescript', 'lib', 'tsserver.js'), '');
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('is the nearest one above the file, and never one outside the project', () => {
    const top = path.join(root, 'node_modules', 'typescript', 'lib', 'tsserver.js');
    expect(findTypeScript(path.join(root, 'packages', 'web', 'src', 'app.ts'), root)).toBe(top);
    expect(findTypeScript(path.join(root, 'packages', 'api', 'index.ts'), root)).toBe(path.join(root, 'packages', 'api', 'node_modules', 'typescript', 'lib', 'tsserver.js'));
    // The project is the folder the user trusted: a TypeScript above it is someone else's code.
    expect(findTypeScript(path.join(root, 'packages', 'web', 'src', 'app.ts'), path.join(root, 'packages', 'web'))).toBeNull();
    expect(findTypeScript(path.join(os.tmpdir(), 'elsewhere.ts'), root)).toBeNull();
  });

  it('checks TypeScript and JavaScript files only', () => {
    for (const name of ['a.ts', 'a.tsx', 'a.mts', 'a.cts', 'a.js', 'a.jsx', 'a.mjs', 'a.cjs', 'A.TS']) expect(isCheckable(name), name).toBe(true);
    for (const name of ['a.d.ts.map', 'a.json', 'a.css', 'a.md', 'ts', 'a.tsbuildinfo']) expect(isCheckable(name), name).toBe(false);
  });
});

describe('a real TypeScript server', () => {
  // This repository's own TypeScript, standing in for the one a project brings.
  const tsserver = path.resolve(__dirname, '..', '..', 'node_modules', 'typescript', 'lib', 'tsserver.js');
  let project: string;
  let intel: CodeIntel;

  beforeAll(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-intel-'));
    fs.writeFileSync(path.join(project, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' }, include: ['*.ts'] }));
    fs.writeFileSync(path.join(project, 'shape.ts'), 'export interface Shape {\n  sides: number;\n}\n');
    fs.writeFileSync(path.join(project, 'good.ts'), "import type { Shape } from './shape';\nexport const square: Shape = { sides: 4 };\n");
    intel = new CodeIntel({ execPath: process.execPath, runAsNode: false, typescriptFor: () => tsserver, firstAnswerMs: 25_000, answerMs: 15_000 });
  });
  afterAll(() => {
    intel.dispose();
    // The server is being stopped, not yet gone: on Windows its open files hold the folder for a moment.
    fs.rmSync(project, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  it('finds nothing wrong with a file that is right', async () => {
    expect(await intel.problems(path.join(project, 'good.ts'), project)).toEqual({ source: 'TypeScript', problems: [], total: 0 });
  });

  it('reports a type error the moment the file has one, and its absence once it is fixed', async () => {
    const file = path.join(project, 'bad.ts');
    fs.writeFileSync(file, "import type { Shape } from './shape';\nexport const triangle: Shape = { sides: 'three' };\n");
    const broken = await intel.problems(file, project);
    expect(broken?.total).toBe(1);
    expect(broken?.problems[0]).toMatchObject({ line: 2, code: 2322 });
    expect(broken?.problems[0]?.text).toContain("Type 'string' is not assignable to type 'number'");

    fs.writeFileSync(file, "import type { Shape } from './shape';\nexport const triangle: Shape = { sides: 3 };\n");
    expect((await intel.problems(file, project))?.total).toBe(0);
  });

  it('sees a change in another file that this one depends on', async () => {
    const file = path.join(project, 'user.ts');
    fs.writeFileSync(file, "import type { Shape } from './shape';\nexport const line: Shape = { sides: 2 };\n");
    expect((await intel.problems(file, project))?.total).toBe(0);
    // The interface gains a required member, the way an edit would change it: written, then checked itself.
    fs.writeFileSync(path.join(project, 'shape.ts'), 'export interface Shape {\n  sides: number;\n  name: string;\n}\n');
    expect((await intel.problems(path.join(project, 'shape.ts'), project))?.total).toBe(0);
    // The file that uses it is now wrong, though it did not change.
    const after = await intel.problems(file, project);
    expect(after?.total).toBe(1);
    expect(after?.problems[0]?.code).toBe(2741);
  });

  it('reports a syntax error as one', async () => {
    const file = path.join(project, 'syntax.ts');
    fs.writeFileSync(file, 'export function broken( {\n  return 1;\n}\n');
    const found = await intel.problems(file, project);
    expect(found?.total).toBeGreaterThan(0);
    expect(found?.problems[0]?.code).toBeLessThan(2000);
  });

  it('says nothing for a file it cannot check, a project without TypeScript, or after it is shut down', async () => {
    expect(await intel.problems(path.join(project, 'notes.md'), project)).toBeNull();
    const bare = new CodeIntel({ execPath: process.execPath, runAsNode: false, typescriptFor: () => null });
    expect(await bare.problems(path.join(project, 'good.ts'), project)).toBeNull();
    bare.dispose();
    const gone = new CodeIntel({ execPath: process.execPath, runAsNode: false, typescriptFor: () => tsserver });
    gone.dispose();
    expect(await gone.problems(path.join(project, 'good.ts'), project)).toBeNull();
  });
});
