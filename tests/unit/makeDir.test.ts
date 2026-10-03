import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeDir, makeDirSync } from '../../src/main/files/makeDir';
import { writeFileAtomic } from '../../src/main/tools/fs/write';
import { makeTempDir, removeDir, writeFile } from '../support/tmp';

const dirs: string[] = [];
function temp(): string {
  const dir = makeTempDir();
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) removeDir(dir);
});

/** How Controlled folder access answers an app it blocks: "not found", although the parent exists. */
function refusal(): NodeJS.ErrnoException {
  return Object.assign(new Error('ENOENT: no such file or directory, mkdir'), { code: 'ENOENT', errno: -4058 });
}

const onWindows = process.platform === 'win32';

describe('making folders', () => {
  it('creates missing parents, accepts a folder that exists and refuses a file in the way', async () => {
    const root = temp();
    makeDirSync(path.join(root, 'a', 'b'));
    await makeDir(path.join(root, 'c', 'd', 'e'));
    expect(fs.statSync(path.join(root, 'a', 'b')).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(root, 'c', 'd', 'e')).isDirectory()).toBe(true);
    makeDirSync(path.join(root, 'a', 'b'));
    await makeDir(root);

    writeFile(root, 'notes.txt', 'x');
    expect(() => makeDirSync(path.join(root, 'notes.txt', 'inner'))).toThrow(/notes\.txt: a file with that name is in the way/);
    await expect(makeDir(path.join(root, 'notes.txt', 'inner'))).rejects.toThrow(/a file with that name is in the way/);
  });

  it("stops at the first refused folder instead of retrying it forever like Node's recursive mkdir", async () => {
    const root = temp();
    const mkdirSync = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {
      throw refusal();
    });
    expect(() => makeDirSync(path.join(root, 'site', 'assets'))).toThrow(onWindows ? /Windows didn't let Graft create .*site\. If Controlled folder access is on/ : /ENOENT/);
    expect(mkdirSync).toHaveBeenCalledTimes(1);

    const mkdir = vi.spyOn(fs.promises, 'mkdir').mockImplementation(() => Promise.reject(refusal()));
    await expect(makeDir(path.join(root, 'site', 'assets'))).rejects.toThrow(onWindows ? /Controlled folder access/ : /ENOENT/);
    expect(mkdir).toHaveBeenCalledTimes(1);
  });

  it('explains a write Windows refused, and a folder a written file needed', async () => {
    const root = temp();
    vi.spyOn(fs.promises, 'writeFile').mockImplementation(() => Promise.reject(refusal()));
    await expect(writeFileAtomic(path.join(root, 'index.html'), '<h1>Hi</h1>')).rejects.toThrow(onWindows ? /Windows didn't let Graft write .*index\.html/ : /ENOENT/);
    vi.restoreAllMocks();

    vi.spyOn(fs.promises, 'mkdir').mockImplementation(() => Promise.reject(refusal()));
    await expect(writeFileAtomic(path.join(root, 'css', 'site.css'), 'body{}')).rejects.toThrow(onWindows ? /Windows didn't let Graft create/ : /ENOENT/);
  });

  it.runIf(onWindows)("doesn't blame Controlled folder access for a name Windows doesn't allow", async () => {
    const root = temp();
    expect(() => makeDirSync(path.join(root, 'what?', 'inner'))).toThrow(/^EINVAL/);
    await expect(writeFileAtomic(path.join(root, 'a:b', 'page.html'), 'x')).rejects.toThrow(/^EINVAL/);
  });
});
