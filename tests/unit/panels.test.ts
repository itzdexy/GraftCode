import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAllowedUrl, normalizeUrl } from '../../src/main/browser/browserPanel';
import { ArtifactServer } from '../../src/main/artifacts/artifacts';
import { canOpenFile, listDirectory, MAX_MEDIA_BYTES, mediaFile, mediaKindOf, openableFile, readPreview } from '../../src/main/files/fileTree';
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

  it('knows pictures, clips and sound by their names', () => {
    expect(['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.webp', 'f.bmp', 'g.ico', 'h.avif', 'i.svg'].map(mediaKindOf)).toEqual(Array.from({ length: 9 }, () => 'image'));
    expect(['clip.mp4', 'clip.webm'].map(mediaKindOf)).toEqual(['video', 'video']);
    expect(['take.mp3', 'take.wav'].map(mediaKindOf)).toEqual(['audio', 'audio']);
    expect(['notes.md', 'photo.png.txt', 'png', 'archive.zip'].map(mediaKindOf)).toEqual([null, null, null, null]);
  });

  it('offers a picture as a picture whatever its size, instead of calling it binary or too large to preview', async () => {
    const root = makeTempDir();
    // A generated image: well past the limit for text, and not text at all.
    writeFile(root, 'comfyui-output/atrium.png', Buffer.alloc(1_600_000, 7));
    writeFile(root, 'small.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
    writeFile(root, 'clip.mp4', Buffer.alloc(2048, 1));
    expect(await readPreview(root, 'comfyui-output/atrium.png')).toEqual({ path: 'comfyui-output/atrium.png', content: null, binary: true, tooLarge: false, size: 1_600_000, media: 'image' });
    expect(await readPreview(root, 'small.png')).toMatchObject({ media: 'image', tooLarge: false, content: null });
    expect(await readPreview(root, 'clip.mp4')).toMatchObject({ media: 'video', tooLarge: false });
    // Text stays text.
    writeFile(root, 'text.md', '# Title\n');
    expect(await readPreview(root, 'text.md')).toMatchObject({ media: null, content: '# Title\n' });
    removeDir(root);
  });

  it('shows a drawing both ways: an SVG is a picture and its source', async () => {
    const root = makeTempDir();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>';
    writeFile(root, 'logo.svg', svg);
    expect(await readPreview(root, 'logo.svg')).toMatchObject({ media: 'image', content: svg, binary: false });
    removeDir(root);
  });

  it('hands out a media file for showing only when it is one, is inside the folder, and is not enormous', async () => {
    const root = makeTempDir();
    writeFile(root, 'art/a.png', Buffer.from([1, 2, 3]));
    writeFile(root, 'notes.txt', 'hello');
    const found = await mediaFile(root, 'art/a.png');
    expect(found).toEqual({ file: path.join(root, 'art', 'a.png'), kind: 'image', size: 3 });
    await expect(mediaFile(root, 'notes.txt')).rejects.toMatchObject({ code: 'not_media' });
    await expect(mediaFile(root, '../a.png')).rejects.toMatchObject({ code: 'outside_folder' });
    await expect(mediaFile(root, 'art/missing.png')).rejects.toMatchObject({ code: 'not_found' });
    await expect(mediaFile(root, 'art')).rejects.toMatchObject({ code: 'not_media' });
    // The limit is on what is loaded into the app, checked from the size on disk.
    const big = path.join(root, 'big.png');
    fs.writeFileSync(big, '');
    fs.truncateSync(big, MAX_MEDIA_BYTES + 1);
    await expect(mediaFile(root, 'big.png')).rejects.toMatchObject({ code: 'too_large' });
    expect(await readPreview(root, 'big.png')).toMatchObject({ media: 'image', tooLarge: true });
    removeDir(root);
  });
});

describe('opening a file with the computer’s own app', () => {
  it('opens documents, pictures, clips and sound, and never something a click could run', async () => {
    expect(['a.png', 'photo.JPG', 'clip.mp4', 'take.wav', 'notes.md', 'page.html', 'data.csv', 'paper.pdf', 'icon.ico'].map(canOpenFile)).toEqual(Array.from({ length: 9 }, () => true));
    expect(['run.bat', 'tool.exe', 'setup.msi', 'script.js', 'job.ps1', 'build.sh', 'main.py', 'link.lnk', 'noextension', '.env'].map(canOpenFile)).toEqual(Array.from({ length: 10 }, () => false));
    const root = makeTempDir();
    writeFile(root, 'out/a.png', Buffer.from([1]));
    writeFile(root, 'run.bat', '@echo off');
    expect(await openableFile(root, 'out/a.png')).toBe(path.join(root, 'out', 'a.png'));
    await expect(openableFile(root, 'run.bat')).rejects.toMatchObject({ code: 'file_not_openable' });
    await expect(openableFile(root, 'out')).rejects.toMatchObject({ code: 'not_a_file' });
    await expect(openableFile(root, 'out/gone.png')).rejects.toMatchObject({ code: 'not_found' });
    await expect(openableFile(root, '../a.png')).rejects.toMatchObject({ code: 'outside_folder' });
    removeDir(root);
  });
});

describe('showing one file through the preview address', () => {
  it('serves that file and nothing beside it', async () => {
    const root = makeTempDir();
    writeFile(root, 'out/picture.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFile(root, 'out/secret.txt', 'do not serve');
    const server = new ArtifactServer();
    const url = server.urlForFile(path.join(root, 'out', 'picture.png'));
    expect(url).toMatch(/^graft-artifact:\/\/[0-9a-f]{32}\/picture\.png$/);
    const ok = await server.respond(url);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await ok.arrayBuffer())).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    // The file next to it is not part of the grant, by name or by walking up.
    const base = url.slice(0, url.lastIndexOf('/'));
    expect((await server.respond(`${base}/secret.txt`)).status).toBe(403);
    expect((await server.respond(`${base}/..%2Fout%2Fsecret.txt`)).status).toBe(403);
    // A folder grant (an HTML artifact and what it links to) still serves its siblings.
    const page = server.urlFor(path.join(root, 'out', 'picture.png'));
    expect((await server.respond(`${page.slice(0, page.lastIndexOf('/'))}/secret.txt`)).status).toBe(200);
    removeDir(root);
  });

  it('names a file with spaces and symbols so the address still finds it', async () => {
    const root = makeTempDir();
    writeFile(root, 'my art #1 (final).png', Buffer.from([1]));
    const server = new ArtifactServer();
    const response = await server.respond(server.urlForFile(path.join(root, 'my art #1 (final).png')));
    expect(response.status).toBe(200);
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

describe('local addresses in the Browser panel', () => {
  it('opens sites and other *.localhost addresses over http', () => {
    expect(normalizeUrl('peach-palace.localhost:4870')).toBe('http://peach-palace.localhost:4870');
    expect(normalizeUrl('app.localhost:3000/about')).toBe('http://app.localhost:3000/about');
  });
});
