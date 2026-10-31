import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyFileEdits, applyTextEdits } from '../../src/main/files/applyEdits';
import { renameEdits } from '../../src/main/languages/rename';
import { makeTempDir, removeDir } from '../support/tmp';

const sha = (text: string): string => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const at = (line: number, character: number) => ({ line, character });

let root: string;
beforeEach(() => { root = makeTempDir(); });
afterEach(() => removeDir(root));

describe('a rename from the language server', () => {
  it('turns a WorkspaceEdit into 1-based edits per project file, from changes and from document changes', () => {
    const locate = (uri: string): string | null => uri.replace('file:///project/', '');
    const edits = renameEdits({
      changes: { 'file:///project/main.ts': [{ range: { start: at(0, 9), end: at(0, 14) }, newText: 'thrice' }], 'file:///project/empty.ts': [] },
      documentChanges: [{ textDocument: { uri: 'file:///project/lib/a.ts', version: 3 }, edits: [{ range: { start: at(2, 0), end: at(2, 5) }, newText: 'thrice' }] }]
    }, locate);
    expect([...edits]).toEqual([
      ['main.ts', [{ line: 1, column: 10, endLine: 1, endColumn: 15, text: 'thrice' }]],
      ['lib/a.ts', [{ line: 3, column: 1, endLine: 3, endColumn: 6, text: 'thrice' }]]
    ]);
    expect(renameEdits(null, locate).size).toBe(0);
  });

  it('refuses the whole rename when one file lies outside the project or a file would be created, moved or deleted', () => {
    const locate = (uri: string): string | null => (uri.startsWith('file:///project/') ? uri.slice(16) : null);
    const inside = { range: { start: at(0, 0), end: at(0, 1) }, newText: 'x' };
    expect(() => renameEdits({ changes: { 'file:///project/a.ts': [inside], 'file:///elsewhere/b.ts': [inside] } }, locate)).toThrow(/outside the project/);
    expect(() => renameEdits({ documentChanges: [{ kind: 'rename', oldUri: 'file:///project/a.ts', newUri: 'file:///project/b.ts' }] }, locate)).toThrow(/create, move or delete/);
    expect(() => renameEdits({ changes: 'nonsense' }, locate)).toThrow(/cannot read/);
  });
});

describe('applying edits to text', () => {
  it('counts lines as a language server does and keeps the line breaks', () => {
    const text = 'const twice = 1;\r\nuse(twice);\rlast twice\n';
    const out = applyTextEdits(text, [
      { line: 3, column: 6, endLine: 3, endColumn: 11, text: 'thrice' },
      { line: 1, column: 7, endLine: 1, endColumn: 12, text: 'thrice' },
      { line: 2, column: 5, endLine: 2, endColumn: 10, text: 'thrice' },
      { line: 4, column: 1, endLine: 4, endColumn: 1, text: '// end\n' }
    ]);
    expect(out).toBe('const thrice = 1;\r\nuse(thrice);\rlast thrice\n// end\n');
  });

  it('refuses edits that overlap or name a place the text does not have', () => {
    expect(() => applyTextEdits('abcdef', [{ line: 1, column: 1, endLine: 1, endColumn: 4, text: 'x' }, { line: 1, column: 3, endLine: 1, endColumn: 5, text: 'y' }])).toThrow(/overlap/);
    expect(() => applyTextEdits('abc', [{ line: 1, column: 5, endLine: 1, endColumn: 5, text: 'x' }])).toThrow(/does not have/);
    expect(() => applyTextEdits('abc', [{ line: 2, column: 1, endLine: 2, endColumn: 1, text: 'x' }])).toThrow(/does not have/);
  });
});

describe('writing a rename to the files', () => {
  const write = (name: string, text: string): string => {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
    return sha(text);
  };
  const edit = (file: string, revision: string, line: number) => ({ file, revision, edits: [{ line, column: 8, endLine: line, endColumn: 13, text: 'thrice' }] });

  it('writes every file when each is still what the server saw', async () => {
    const a = write('a.ts', 'export twice;\n'), b = write('src/b.ts', '\nimport twice;\n');
    await applyFileEdits(root, [edit('a.ts', a, 1), edit('src/b.ts', b, 2)]);
    expect(fs.readFileSync(path.join(root, 'a.ts'), 'utf8')).toBe('export thrice;\n');
    expect(fs.readFileSync(path.join(root, 'src/b.ts'), 'utf8')).toBe('\nimport thrice;\n');
  });

  it('changes no file when one changed on disk since the server saw it', async () => {
    const a = write('a.ts', 'export twice;\n'), b = write('b.ts', 'import twice;\n');
    fs.writeFileSync(path.join(root, 'b.ts'), 'import twice; // edited by the agent\n');
    await expect(applyFileEdits(root, [edit('a.ts', a, 1), edit('b.ts', b, 1)])).rejects.toMatchObject({ code: 'file_changed' });
    expect(fs.readFileSync(path.join(root, 'a.ts'), 'utf8')).toBe('export twice;\n');
    expect(fs.readFileSync(path.join(root, 'b.ts'), 'utf8')).toBe('import twice; // edited by the agent\n');
  });

  it('refuses a file outside the project, inside Git metadata or gone, and changes nothing', async () => {
    const a = write('a.ts', 'export twice;\n');
    const outside = makeTempDir();
    try {
      fs.writeFileSync(path.join(outside, 'x.ts'), 'export twice;\n');
      const relative = path.relative(root, path.join(outside, 'x.ts')).split(path.sep).join('/');
      await expect(applyFileEdits(root, [edit('a.ts', a, 1), edit(relative, sha('export twice;\n'), 1)])).rejects.toMatchObject({ code: 'outside_folder' });
      expect(fs.readFileSync(path.join(outside, 'x.ts'), 'utf8')).toBe('export twice;\n');
    } finally { removeDir(outside); }
    const config = write('.git/config', 'export twice;\n');
    await expect(applyFileEdits(root, [edit('a.ts', a, 1), edit('.git/config', config, 1)])).rejects.toMatchObject({ code: 'protected_file' });
    await expect(applyFileEdits(root, [edit('a.ts', a, 1), edit('gone.ts', a, 1)])).rejects.toMatchObject({ code: 'not_found' });
    await expect(applyFileEdits(root, [edit('a.ts', a, 1), edit('a.ts', a, 1)])).rejects.toMatchObject({ code: 'edit_files' });
    expect(fs.readFileSync(path.join(root, 'a.ts'), 'utf8')).toBe('export twice;\n');
  });
});
