import { describe, expect, it } from 'vitest';
import { absolutePath, actionsFor, mentionOf, previewNote, withMention } from '../../../src/renderer/src/features/panels/fileActions';

describe('where a file is', () => {
  it('writes the full path the way the computer writes paths', () => {
    expect(absolutePath('C:\\Users\\dexy\\code\\demo', 'comfyui-output/interior_atrium_00001_.png', 'win32')).toBe('C:\\Users\\dexy\\code\\demo\\comfyui-output\\interior_atrium_00001_.png');
    expect(absolutePath('C:/Users/dexy/code/demo/', 'a/b.txt', 'win32')).toBe('C:\\Users\\dexy\\code\\demo\\a\\b.txt');
    expect(absolutePath('/home/dexy/demo', 'a/b.txt', 'linux')).toBe('/home/dexy/demo/a/b.txt');
    expect(absolutePath('/home/dexy/demo/', '', 'darwin')).toBe('/home/dexy/demo');
  });

  it('mentions a file in a message so the agent is pointed at it, quoting a path with spaces', () => {
    expect(mentionOf('src/app.ts')).toBe('@src/app.ts');
    expect(mentionOf('my art/final image.png')).toBe('@"my art/final image.png"');
  });

  it('adds a mention to what is already typed, on the same line, ready to keep typing', () => {
    expect(withMention('', 'a.png')).toBe('@a.png ');
    expect(withMention('Look at', 'a.png')).toBe('Look at @a.png ');
    expect(withMention('Look at ', 'a.png')).toBe('Look at @a.png ');
    expect(withMention('First line\n', 'a.png')).toBe('First line\n@a.png ');
  });
});

describe('what can be done with a file', () => {
  it('offers a picture everything: its paths, the picture itself, its folder, the app that opens it, the editor, the message', () => {
    expect(actionsFor({ path: 'out/a.png', type: 'file' })).toEqual(['copy-path', 'copy-relative', 'copy-image', 'reveal', 'open', 'editor', 'mention']);
    expect(actionsFor({ path: 'out/photo.JPG', type: 'file' })).toContain('copy-image');
  });

  it('copies only pictures as pictures, and only the kinds the clipboard takes', () => {
    for (const path of ['logo.svg', 'anim.gif', 'clip.mp4', 'notes.md']) expect(actionsFor({ path, type: 'file' })).not.toContain('copy-image');
  });

  it('never offers to open something a click could run', () => {
    for (const path of ['run.bat', 'tool.exe', 'script.js', 'job.ps1', 'main.py', 'Makefile']) {
      expect(actionsFor({ path, type: 'file' })).toEqual(['copy-path', 'copy-relative', 'reveal', 'editor', 'mention']);
    }
    expect(actionsFor({ path: 'notes.md', type: 'file' })).toContain('open');
    expect(actionsFor({ path: 'clip.mp4', type: 'file' })).toContain('open');
  });

  it('offers a folder its paths, itself in the file manager, the editor and the message', () => {
    expect(actionsFor({ path: 'src/components', type: 'dir' })).toEqual(['copy-path', 'copy-relative', 'reveal', 'editor', 'mention']);
  });
});

describe('what the preview says about a file', () => {
  it('gives a picture its size on disk and, once it has loaded, its size in pixels', () => {
    expect(previewNote({ size: 1_612_800, media: 'image' }, null)).toBe('1.5 MB');
    expect(previewNote({ size: 1_612_800, media: 'image' }, { width: 1024, height: 768 })).toBe('1024 × 768 · 1.5 MB');
    expect(previewNote({ size: 2048, media: null }, null)).toBe('2.0 KB');
  });
});
