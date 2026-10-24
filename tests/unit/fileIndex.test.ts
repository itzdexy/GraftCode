import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileIndex } from '../../src/main/ipc/fileIndex';
import { makeTempDir, removeDir, writeFile } from '../support/tmp';
import { RG_PATH } from '../support/toolContext';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(removeDir));

describe('the file a reply names', () => {
  it('is the path as written, an absolute path inside, or the one file that ends with it', async () => {
    const root = makeTempDir();
    dirs.push(root);
    for (const f of ['src/health.js', 'test/health.test.js', 'src/a/index.ts', 'src/b/index.ts', 'dist/out.js']) writeFile(root, f, '');
    writeFile(root, '.gitignore', 'dist/\n');
    writeFile(path.dirname(root), `${path.basename(root)}-outside.js`, '');
    dirs.push(path.join(path.dirname(root), `${path.basename(root)}-outside.js`));
    const asked = ['src/health.js', 'health.test.js', 'index.ts', 'a/index.ts', path.join(root, 'src', 'health.js'), 'dist/out.js', 'nope.js', `../${path.basename(root)}-outside.js`, 'src'];
    expect(await new FileIndex(RG_PATH).resolve(root, asked)).toEqual(['src/health.js', 'test/health.test.js', null, 'src/a/index.ts', 'src/health.js', 'dist/out.js', null, null, null]);
  });

  it('takes Windows separators, a leading ./ and a path that climbs and comes back', async () => {
    const root = makeTempDir();
    dirs.push(root);
    for (const f of ['src/win/a.ts', 'docs/read me.md']) writeFile(root, f, '');
    const index = new FileIndex(RG_PATH);
    expect(await index.resolve(root, ['src\\win\\a.ts', './src/win/a.ts', 'src/../src/win/a.ts', 'win\\a.ts', path.join(root, '..', 'elsewhere.ts')])).toEqual(['src/win/a.ts', 'src/win/a.ts', 'src/win/a.ts', 'src/win/a.ts', null]);
  });

  it('finds a file made after the list was read, by its exact path', async () => {
    const root = makeTempDir();
    dirs.push(root);
    writeFile(root, 'a.ts', '');
    const index = new FileIndex(RG_PATH);
    expect(await index.resolve(root, ['a.ts', 'made/later.ts'])).toEqual(['a.ts', null]);
    writeFile(root, 'made/later.ts', '');
    expect(await index.resolve(root, ['made/later.ts'])).toEqual(['made/later.ts']);
  });

  it('reads the list again when asked to, so a new file is found by its name alone', async () => {
    const root = makeTempDir();
    dirs.push(root);
    writeFile(root, 'a.ts', '');
    const index = new FileIndex(RG_PATH);
    expect(await index.resolve(root, ['later.ts'])).toEqual([null]);
    writeFile(root, 'made/later.ts', '');
    expect(await index.resolve(root, ['later.ts'])).toEqual([null]);
    expect(await index.resolve(root, ['later.ts'], true)).toEqual(['made/later.ts']);
  });
});
