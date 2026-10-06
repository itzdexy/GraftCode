import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readTool } from '../../src/main/tools/fs/read';
import { writeTool } from '../../src/main/tools/fs/write';
import { applyEdit, editTool, multiEditTool } from '../../src/main/tools/fs/edit';
import { globTool } from '../../src/main/tools/search/glob';
import { grepTool } from '../../src/main/tools/search/grep';
import { createBuiltinRegistry } from '../../src/main/tools/builtin';
import { isInside, isInsideReal, resolvePath } from '../../src/main/tools/paths';
import { makeTempDir, removeDir, writeFile } from '../support/tmp';
import { makeToolContext } from '../support/toolContext';

let dir: string;
beforeEach(() => {
  dir = makeTempDir();
});
afterEach(() => {
  removeDir(dir);
});

const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? '').join('\n');

describe('Read', () => {
  it('returns numbered lines for a range and tells how to continue', async () => {
    writeFile(dir, 'src/a.ts', Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
    const ctx = makeToolContext(dir);
    const result = await readTool.execute({ file_path: 'src/a.ts', offset: 10, limit: 3 }, ctx);
    expect(result.isError).toBe(false);
    expect(text(result)).toBe('    10\tline 10\n    11\tline 11\n    12\tline 12\n… 18 more lines. Continue with offset=13.');
    expect(result.display).toEqual({ kind: 'read', path: 'src/a.ts', startLine: 10, endLine: 12, totalLines: 30, image: false });
  });

  it('handles CRLF, BOM, empty files, missing files, directories, binaries and offsets past the end', async () => {
    const ctx = makeToolContext(dir);
    writeFile(dir, 'crlf.txt', '\ufefffirst\r\nsecond\r\n');
    expect(text(await readTool.execute({ file_path: 'crlf.txt' }, ctx))).toBe('     1\tfirst\n     2\tsecond');
    writeFile(dir, 'empty.txt', '');
    expect(text(await readTool.execute({ file_path: 'empty.txt' }, ctx))).toBe('(file is empty)');
    expect((await readTool.execute({ file_path: 'nope.txt' }, ctx)).isError).toBe(true);
    expect(text(await readTool.execute({ file_path: '.' }, ctx))).toMatch(/is a directory/);
    writeFile(dir, 'blob.bin', Buffer.from([1, 2, 0, 3]));
    expect(text(await readTool.execute({ file_path: 'blob.bin' }, ctx))).toMatch(/binary file/);
    expect(text(await readTool.execute({ file_path: 'crlf.txt', offset: 5 }, ctx))).toMatch(/past the end/);
  });

  it('returns images as image blocks only for vision models', async () => {
    writeFile(dir, 'pic.png', Buffer.from('89504e470d0a1a0a0000', 'hex'));
    const vision = await readTool.execute({ file_path: 'pic.png' }, makeToolContext(dir));
    expect(vision.content[0]).toMatchObject({ type: 'image', mediaType: 'image/png' });
    const blind = await readTool.execute({ file_path: 'pic.png' }, makeToolContext(dir, { modelSupportsVision: false }));
    expect(text(blind)).toMatch(/can't view images/);
  });

  it('appends project notes for newly touched directories', async () => {
    writeFile(dir, 'pkg/x.ts', 'x');
    const ctx = makeToolContext(dir, { notesForPaths: () => '<project-notes>use tabs</project-notes>' });
    const result = await readTool.execute({ file_path: 'pkg/x.ts' }, ctx);
    expect(result.content).toHaveLength(2);
    expect(text(result)).toContain('use tabs');
  });
});

describe('Write', () => {
  it('creates new files without a prior read and returns a diff', async () => {
    const ctx = makeToolContext(dir);
    const result = await writeTool.execute({ file_path: 'new dir/file.txt', content: 'a\nb\n' }, ctx);
    expect(result.isError).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'new dir/file.txt'), 'utf8')).toBe('a\nb\n');
    expect(result.display).toMatchObject({ kind: 'edit', created: true, added: 2, removed: 0 });
    expect(fs.readdirSync(path.join(dir, 'new dir')).filter((f) => f.includes('graft-tmp'))).toEqual([]);
  });

  it('refuses to overwrite a file that was not read, or that changed since', async () => {
    writeFile(dir, 'f.txt', 'original');
    const ctx = makeToolContext(dir);
    expect(text(await writeTool.execute({ file_path: 'f.txt', content: 'x' }, ctx))).toMatch(/Read f.txt before overwriting/);
    await readTool.execute({ file_path: 'f.txt' }, ctx);
    fs.writeFileSync(path.join(dir, 'f.txt'), 'changed by someone else');
    expect(text(await writeTool.execute({ file_path: 'f.txt', content: 'x' }, ctx))).toMatch(/changed since you last read/);
    expect(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8')).toBe('changed by someone else');
  });
});

describe('Edit and MultiEdit', () => {
  it('applies a unique replacement and reports counts', async () => {
    writeFile(dir, 'a.ts', 'const a = 1;\nconst b = 2;\n');
    const ctx = makeToolContext(dir);
    await readTool.execute({ file_path: 'a.ts' }, ctx);
    const result = await editTool.execute({ file_path: 'a.ts', old_string: 'const b = 2;', new_string: 'const b = 3;' }, ctx);
    expect(result.isError).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'a.ts'), 'utf8')).toBe('const a = 1;\nconst b = 3;\n');
    expect(result.display).toMatchObject({ kind: 'edit', added: 1, removed: 1 });
  });

  it('explains ambiguous and missing matches precisely', () => {
    const ambiguous = applyEdit('x\nx\n', { old_string: 'x', new_string: 'y' });
    expect(ambiguous.ok ? '' : ambiguous.error).toMatch(/appears 2 times/);
    const miss = applyEdit('function go() {\n  return 1;\n}\n', { old_string: 'function go() {\n  return 2;', new_string: 'z' });
    expect(miss.ok).toBe(false);
    expect(miss.ok ? '' : miss.error).toMatch(/line 1/);
    expect(applyEdit('abc', { old_string: 'abc', new_string: 'abc' }).ok).toBe(false);
    expect(applyEdit('a a a', { old_string: 'a', new_string: 'b', replace_all: true })).toMatchObject({ ok: true, content: 'b b b', replacements: 3 });
    expect(applyEdit('cost $1', { old_string: 'cost', new_string: 'price $&' })).toMatchObject({ ok: true, content: 'price $& $1' });
  });

  it('shows what the file has where an edit nearly matched, so it can be corrected without another Read', () => {
    const file = 'function go() {\n  return 1;\n}\nfunction stop() {\n  return 0;\n}\n';
    const miss = applyEdit(file, { old_string: 'function go() {\n  return 2;\n}', new_string: 'z' });
    const error = miss.ok ? '' : miss.error;
    expect(error).toMatch(/from line 1/);
    expect(error).toContain('  return 1;');
    // As many lines as the edit named, never the whole file.
    expect(error).not.toContain('function stop');
    const long = applyEdit(`start\n${'x'.repeat(5000)}\n`, { old_string: 'start\nnope', new_string: 'z' });
    expect((long.ok ? '' : long.error).length).toBeLessThan(1500);
  });

  it('matches a block whose indentation differs, and gives the new text the file’s indentation', () => {
    const file = 'class A {\n    go() {\n        return 1;\n    }\n}\n';
    const deeper = applyEdit(file, { old_string: 'go() {\n    return 1;\n}', new_string: 'go() {\n    const n = 2;\n    return n;\n}' });
    expect(deeper).toMatchObject({ ok: true, content: 'class A {\n    go() {\n        const n = 2;\n        return n;\n    }\n}\n', replacements: 1 });
    expect(deeper.ok ? deeper.note : '').toMatch(/lines 2–4/);
    const tabs = applyEdit('if (x) {\n\treturn 1;   \n}\n', { old_string: '  return 1;\n', new_string: '  return 2;\n' });
    expect(tabs).toMatchObject({ ok: true, content: 'if (x) {\n\treturn 2;\n}\n' });
    const shallower = applyEdit('a\n  b();\nc\n', { old_string: '      b();', new_string: '      b();\n      d();' });
    expect(shallower).toMatchObject({ ok: true, content: 'a\n  b();\n  d();\nc\n' });
    const crlf = applyEdit('a\r\n\tb();\r\nc\r\n', { old_string: '  b();\nc', new_string: '  b();\n  d();\nc' });
    expect(crlf).toMatchObject({ ok: true, content: 'a\r\n\tb();\r\n\td();\r\nc\r\n' });
  });

  it('never guesses between several loosely matching blocks, and leaves exact matches alone', () => {
    const twice = applyEdit('  end\n\tend\n', { old_string: '    end', new_string: 'done' });
    expect(twice.ok ? '' : twice.error).toMatch(/2 places/);
    const exact = applyEdit('  a\n    a\n', { old_string: '    a', new_string: '    b' });
    expect(exact).toMatchObject({ ok: true, content: '  a\n    b\n' });
    expect(exact.ok ? exact.note : 'x').toBeUndefined();
    expect(applyEdit('a\n\n\nb\n', { old_string: '\n \n', new_string: 'x' }).ok).toBe(false);
  });

  it('tells the model when an edit matched loosely', async () => {
    writeFile(dir, 'loose.ts', 'function f() {\n\treturn 1;\n}\n');
    const ctx = makeToolContext(dir);
    await readTool.execute({ file_path: 'loose.ts' }, ctx);
    const result = await editTool.execute({ file_path: 'loose.ts', old_string: '    return 1;', new_string: '    return 2;' }, ctx);
    expect(result.isError).toBe(false);
    expect(text(result)).toMatch(/indentation differed.*line 2/);
    expect(fs.readFileSync(path.join(dir, 'loose.ts'), 'utf8')).toBe('function f() {\n\treturn 2;\n}\n');
  });

  it('matches LF edits against CRLF files and keeps CRLF endings', async () => {
    writeFile(dir, 'win.txt', 'one\r\ntwo\r\nthree\r\n');
    const ctx = makeToolContext(dir);
    await readTool.execute({ file_path: 'win.txt' }, ctx);
    const result = await editTool.execute({ file_path: 'win.txt', old_string: 'one\ntwo', new_string: 'uno\ndos' }, ctx);
    expect(result.isError).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'win.txt'), 'utf8')).toBe('uno\r\ndos\r\nthree\r\n');
  });

  it('requires a read first, and MultiEdit applies nothing when one edit fails', async () => {
    writeFile(dir, 'm.txt', 'alpha beta gamma');
    const ctx = makeToolContext(dir);
    expect(text(await editTool.execute({ file_path: 'm.txt', old_string: 'alpha', new_string: 'A' }, ctx))).toMatch(/Read m.txt before editing/);
    await readTool.execute({ file_path: 'm.txt' }, ctx);
    const failed = await multiEditTool.execute(
      { file_path: 'm.txt', edits: [{ old_string: 'alpha', new_string: 'A' }, { old_string: 'delta', new_string: 'D' }] },
      ctx
    );
    expect(text(failed)).toMatch(/Edit 2 of 2: .*No edits were applied/);
    expect(fs.readFileSync(path.join(dir, 'm.txt'), 'utf8')).toBe('alpha beta gamma');
    const ok = await multiEditTool.execute(
      { file_path: 'm.txt', edits: [{ old_string: 'alpha', new_string: 'A' }, { old_string: 'A beta', new_string: 'AB' }] },
      ctx
    );
    expect(ok.isError).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'm.txt'), 'utf8')).toBe('AB gamma');
  });

  it('previews the pending diff for permission prompts without writing', async () => {
    writeFile(dir, 'p.txt', 'hello\n');
    const described = await editTool.describe({ file_path: 'p.txt', old_string: 'hello', new_string: 'bye' }, { cwd: dir, projectRoot: dir, platform: process.platform });
    expect(described.preview).toMatchObject({ kind: 'edit', created: false });
    expect(described.preview?.kind === 'edit' ? described.preview.patch : '').toContain('-hello\n+bye');
    expect(fs.readFileSync(path.join(dir, 'p.txt'), 'utf8')).toBe('hello\n');
  });
});

describe('Glob and Grep', () => {
  beforeEach(() => {
    writeFile(dir, '.gitignore', 'ignored/\n');
    writeFile(dir, 'src/app.ts', 'export const TODO_ITEM = 1;\n// TODO: fix\n');
    writeFile(dir, 'src/util/helpers.ts', 'export function helper() {}\n');
    writeFile(dir, 'ignored/skip.ts', 'TODO hidden\n');
    writeFile(dir, 'README.md', 'TODO docs\n');
    fs.mkdirSync(path.join(dir, '.git'));
  });

  it('finds files by pattern, respecting .gitignore, newest first', async () => {
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(dir, 'src/util/helpers.ts'), future, future);
    const result = await globTool.execute({ pattern: '*.ts' }, makeToolContext(dir));
    expect(result.display).toMatchObject({ kind: 'glob', count: 2, files: ['src/util/helpers.ts', 'src/app.ts'] });
  });

  it('searches contents with paths relative to the working directory', async () => {
    const ctx = makeToolContext(dir);
    const files = await grepTool.execute({ pattern: 'TODO' }, ctx);
    expect(text(files).split('\n').slice(1).sort()).toEqual(['README.md', 'src/app.ts']);
    const content = await grepTool.execute({ pattern: 'TODO:', output_mode: 'content' }, ctx);
    expect(text(content)).toContain('src/app.ts:2:// TODO: fix');
    const single = await grepTool.execute({ pattern: 'helper', path: 'src/util/helpers.ts', output_mode: 'content' }, ctx);
    expect(text(single)).toContain('src/util/helpers.ts:1:export function helper() {}');
    expect(text(await grepTool.execute({ pattern: 'nothing-here-123' }, ctx))).toMatch(/No matches/);
    const bad = await grepTool.execute({ pattern: '(unclosed' }, ctx);
    expect(bad.isError).toBe(true);
  });
});

describe('paths and registry', () => {
  it('detects escapes, including through symlinks and case on Windows', () => {
    expect(isInside(dir, path.join(dir, 'a', '..', 'b'))).toBe(true);
    expect(isInside(dir, path.join(dir, '..', 'elsewhere'))).toBe(false);
    expect(isInside('C:\\Repo', 'c:\\repo\\src\\x.ts', 'win32')).toBe(true);
    const home = process.platform === 'win32' ? 'C:\\Users\\me' : '/home/me';
    expect(resolvePath('~/notes.md', dir, home)).toBe(path.resolve(home, 'notes.md'));
    const outside = makeTempDir();
    try {
      fs.symlinkSync(outside, path.join(dir, 'link'), 'junction');
      expect(isInside(dir, path.join(dir, 'link', 'secret.txt'))).toBe(true);
      expect(isInsideReal(dir, path.join(dir, 'link', 'secret.txt'))).toBe(false);
    } finally {
      removeDir(outside);
    }
  });

  it('exposes every built-in tool with a JSON schema, in stable order', () => {
    const registry = createBuiltinRegistry();
    const specs = registry.specs();
    expect(specs.map((s) => s.name)).toEqual([...specs.map((s) => s.name)].sort((a, b) => a.localeCompare(b)));
    expect(specs.map((s) => s.name)).toEqual(
      expect.arrayContaining(['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'Shell', 'ShellOutput', 'KillShell', 'WebFetch', 'TodoWrite', 'Task', 'AskUserQuestion', 'ExitPlanMode'])
    );
    const edit = specs.find((s) => s.name === 'Edit');
    expect(edit?.inputSchema).toMatchObject({ type: 'object', required: expect.arrayContaining(['file_path', 'old_string', 'new_string']) as unknown });
    expect(edit?.inputSchema).not.toHaveProperty('$schema');
  });
});
