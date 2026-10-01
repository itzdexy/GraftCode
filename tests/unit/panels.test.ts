import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAllowedUrl, normalizeUrl } from '../../src/main/browser/browserPanel';
import { listDirectory, readPreview } from '../../src/main/files/fileTree';
import { interactiveArgs, PtyManager } from '../../src/main/pty/ptyManager';
import { detectShell } from '../../src/main/tools/shell/detect';
import { makeTempDir, removeDir, writeFile } from '../support/tmp';

describe('browser panel addresses', () => {
  it('only allows http and https', () => {
    expect(isAllowedUrl('https://example.com')).toBe(true);
    expect(isAllowedUrl('http://localhost:5173/app')).toBe(true);
    for (const bad of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'data:text/html,hi', 'chrome://settings', 'devtools://x', 'not a url']) {
      expect(isAllowedUrl(bad)).toBe(false);
    }
  });

  it('adds a scheme to bare hosts and keeps local servers on http', () => {
    expect(normalizeUrl('localhost:3000')).toBe('http://localhost:3000');
    expect(normalizeUrl('127.0.0.1:5173/docs')).toBe('http://127.0.0.1:5173/docs');
    expect(normalizeUrl('example.com/path')).toBe('https://example.com/path');
    expect(normalizeUrl('  https://example.com  ')).toBe('https://example.com');
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('file:///etc/passwd')).toBeNull();
    expect(normalizeUrl('')).toBeNull();
  });
});

describe('file tree', () => {
  it('lists folders first, hides .git and refuses paths outside the root', async () => {
    const root = makeTempDir();
    writeFile(root, 'b.txt', 'b');
    writeFile(root, 'a/inner.txt', 'x');
    writeFile(root, '.git/HEAD', 'ref');
    const entries = await listDirectory(root, '');
    expect(entries.map((e) => `${e.type}:${e.path}`)).toEqual(['dir:a', 'file:b.txt']);
    expect((await listDirectory(root, 'a')).map((e) => e.path)).toEqual(['a/inner.txt']);
    await expect(listDirectory(root, '..')).rejects.toMatchObject({ code: 'outside_folder' });
    await expect(readPreview(root, '../outside.txt')).rejects.toMatchObject({ code: 'outside_folder' });
    removeDir(root);
  });

  it('previews text, and reports binary and oversized files without their content', async () => {
    const root = makeTempDir();
    writeFile(root, 'text.md', '# Title\n');
    writeFile(root, 'image.bin', Buffer.from([0, 1, 2, 3]));
    writeFile(root, 'huge.log', 'x'.repeat(600 * 1024));
    expect(await readPreview(root, 'text.md')).toMatchObject({ content: '# Title\n', binary: false, tooLarge: false });
    expect(await readPreview(root, 'image.bin')).toMatchObject({ content: null, binary: true });
    expect(await readPreview(root, 'huge.log')).toMatchObject({ content: null, tooLarge: true });
    await expect(readPreview(root, 'missing.txt')).rejects.toMatchObject({ code: 'not_found' });
    removeDir(root);
  });
});

describe('terminals', () => {
  it('uses interactive arguments for each shell family', () => {
    expect(interactiveArgs({ kind: 'bash', path: 'bash', label: 'bash' })).toEqual(['--login', '-i']);
    expect(interactiveArgs({ kind: 'powershell', path: 'pwsh', label: 'PowerShell' })).toEqual(['-NoLogo']);
  });

  it('runs a real shell in the folder, streams offsets, keeps scrollback and stops on kill', async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'marker-file.txt'), '');
    const shell = detectShell(process.platform, process.env);
    const chunks: Array<{ data: string; offset: number }> = [];
    const exits: number[] = [];
    const manager = new PtyManager(shell, {
      data: (_id, data, offset) => chunks.push({ data, offset }),
      exit: (_id, code) => exits.push(code),
      log: () => undefined
    });
    const term = manager.create('s1', dir, 80, 24);
    const command = shell.kind === 'powershell' ? 'Write-Output "pty-$(20+22)"; Get-ChildItem -Name\r' : 'echo pty-$((20+22)); ls\r';
    manager.write(term.id, command);
    const deadline = Date.now() + 20_000;
    const joined = (): string => chunks.map((c) => c.data).join('');
    while (!(/pty-42/.test(joined()) && /marker-file\.txt/.test(joined())) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(joined()).toMatch(/pty-42/);
    expect(joined()).toMatch(/marker-file\.txt/);
    // Offsets are contiguous. The snapshot holds everything produced so far, including
    // output still waiting in the batch, so it can run ahead of the emitted chunks.
    let expected = 0;
    for (const c of chunks) {
      expect(c.offset).toBe(expected);
      expected += c.data.length;
    }
    const snap = manager.snapshot(term.id);
    expect(snap.data.startsWith(joined())).toBe(true);
    expect(snap.end).toBe(snap.data.length);
    expect(snap.end).toBeGreaterThanOrEqual(expected);
    expect(manager.list('s1')).toHaveLength(1);
    await manager.kill(term.id);
    expect(manager.list('s1')).toHaveLength(0);
    expect(() => manager.write(term.id, 'x')).toThrow(/closed/);
    removeDir(dir);
  }, 40_000);
});
