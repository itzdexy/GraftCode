import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandMentions, findMentions } from '../../src/main/agent/mentions';
import { FileStateTracker } from '../../src/main/tools/fileState';
import { makeTempDir, writeFile } from '../support/tmp';

describe('@ mentions', () => {
  it('finds mentions at word starts, with quotes and trailing punctuation removed', () => {
    expect(findMentions('look at @src/app.ts, and @"docs/read me.md". email me@example.com @src/app.ts')).toEqual([
      'src/app.ts',
      'docs/read me.md'
    ]);
    expect(findMentions('no mentions here')).toEqual([]);
  });

  it('attaches project files with line numbers and lists directories', () => {
    const root = makeTempDir();
    writeFile(root, 'src/app.ts', 'export const x = 1;\r\nexport const y = 2;\n');
    writeFile(root, 'src/util/helpers.ts', '');
    const out = expandMentions('fix @src/app.ts using @src', root, root);
    expect(out.files).toEqual([path.join(root, 'src', 'app.ts')]);
    expect(out.blocks[0]).toContain('<file path="src/app.ts">');
    expect(out.blocks[0]).toMatch(/1\texport const x = 1;\n\s+2\texport const y = 2;/);
    expect(out.blocks[1]).toBe('<directory path="src">\nutil/\napp.ts\n</directory>');
  });

  it('refuses paths outside the project, missing files, binaries and oversized files', () => {
    const root = makeTempDir();
    const outside = makeTempDir();
    writeFile(outside, 'secret.txt', 'top secret');
    writeFile(root, 'bin.dat', Buffer.from([1, 2, 0, 3]));
    writeFile(root, 'big.txt', 'x'.repeat(250_000));
    const rel = path.relative(root, path.join(outside, 'secret.txt'));
    const out = expandMentions(`@${rel} @missing.ts @bin.dat @big.txt`, root, root);
    expect(out.files).toEqual([]);
    expect(out.blocks.join('\n')).not.toContain('top secret');
    expect(out.blocks[0]).toMatch(/outside the project folder/);
    expect(out.blocks[1]).toMatch(/does not exist/);
    expect(out.blocks[2]).toMatch(/binary file/);
    expect(out.blocks[3]).toMatch(/too large to attach/);
  });

  it('attached files count as read for the read-before-edit rule', () => {
    const root = makeTempDir();
    const file = writeFile(root, 'a.txt', 'hello');
    const tracker = new FileStateTracker();
    for (const f of expandMentions('@a.txt', root, root).files) tracker.record(f);
    expect(tracker.check(file)).toEqual({ ok: true });
    fs.writeFileSync(file, 'changed!');
    expect(tracker.check(file).ok).toBe(false);
  });
});
