import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileStateTracker } from '../../src/main/tools/fileState';
import { writeFileAtomic } from '../../src/main/tools/fs/write';
import { makeTempDir, removeDir } from '../support/tmp';

let dir: string;
beforeEach(() => { dir = makeTempDir(); });
afterEach(() => { vi.restoreAllMocks(); removeDir(dir); });

describe('file revision guards', () => {
  it('detects different content even when size and timestamp are unchanged', () => {
    const file = path.join(dir, 'a.ts'); fs.writeFileSync(file, 'one');
    const timestamp = new Date(1700000000000); fs.utimesSync(file, timestamp, timestamp);
    const tracker = new FileStateTracker(); tracker.record(file);
    fs.writeFileSync(file, 'two'); fs.utimesSync(file, timestamp, timestamp);
    expect(tracker.check(file)).toEqual({ ok: false, reason: 'modified' });
  });

  it('refuses a change made while a temporary file was being written and removes its temporary file', async () => {
    const file = path.join(dir, 'a.ts'); fs.writeFileSync(file, 'original');
    const write = fs.promises.writeFile;
    vi.spyOn(fs.promises, 'writeFile').mockImplementationOnce(async (...args) => {
      await write(...args);
      fs.writeFileSync(file, 'user edit');
    });
    await expect(writeFileAtomic(file, 'agent edit', 'original')).rejects.toMatchObject({ code: 'file_conflict' });
    expect(fs.readFileSync(file, 'utf8')).toBe('user edit');
    expect(fs.readdirSync(dir)).toEqual(['a.ts']);
  });

  it('allows only one concurrent replacement of a revision', async () => {
    const file = path.join(dir, 'a.ts'); fs.writeFileSync(file, 'original');
    const results = await Promise.allSettled([writeFileAtomic(file, 'first', 'original'), writeFileAtomic(file, 'second', 'original')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(['first', 'second']).toContain(fs.readFileSync(file, 'utf8'));
  });

  it('creates a file exclusively and preserves files created concurrently', async () => {
    const file = path.join(dir, 'a.ts');
    const results = await Promise.allSettled([writeFileAtomic(file, 'first', null), writeFileAtomic(file, 'second', null)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(fs.readdirSync(dir)).toEqual(['a.ts']);
  });
});
