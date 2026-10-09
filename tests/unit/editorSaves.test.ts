import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readPreview, savePreview } from '../../src/main/files/fileTree';
import { makeTempDir, removeDir } from '../support/tmp';

let root: string;
beforeEach(() => { root = makeTempDir(); });
afterEach(() => removeDir(root));
describe('revision-checked editor saves', () => {
  it('preserves UTF-8 BOM/CRLF, updates the revision and keeps file permissions', async () => {
    const file = path.join(root, 'main.ts'); fs.writeFileSync(file, '\ufeffconst old = 1;\r\n', { mode: 0o640 });
    const before = await readPreview(root, 'main.ts');
    const result = await savePreview(root, 'main.ts', before.content!.replace('old', 'new'), before.revision!);
    expect(fs.readFileSync(file, 'utf8')).toBe('\ufeffconst new = 1;\r\n');
    expect(result.revision).not.toBe(before.revision);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o640);
  });
  it('refuses a changed destination without overwriting the external edit', async () => {
    const file = path.join(root, 'notes.txt'); fs.writeFileSync(file, 'original');
    const before = await readPreview(root, 'notes.txt'); fs.writeFileSync(file, 'external');
    await expect(savePreview(root, 'notes.txt', 'draft', before.revision!)).rejects.toThrow(/changed on disk/);
    expect(fs.readFileSync(file, 'utf8')).toBe('external');
  });
  it('rejects binary/invalid UTF-8, Git metadata and symlink escapes', async () => {
    fs.writeFileSync(path.join(root, 'legacy.txt'), Buffer.from([0xff, 0xfe, 0x61]));
    expect((await readPreview(root, 'legacy.txt')).revision).toBeUndefined();
    fs.mkdirSync(path.join(root, '.git')); fs.writeFileSync(path.join(root, '.git', 'config'), 'original');
    const config = await readPreview(root, '.git/config');
    await expect(savePreview(root, '.git/config', 'changed', config.revision!)).rejects.toThrow(/Git metadata/);
    await expect(savePreview(root, '../outside.txt', 'changed', 'a'.repeat(64))).rejects.toThrow(/outside/);
  });
});
