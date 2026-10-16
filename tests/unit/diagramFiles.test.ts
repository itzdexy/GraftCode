import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clipFor, exportName } from '../../src/main/diagrams/render';
import { diagramFile } from '../../src/main/files/fileTree';
import { makeTempDir, removeDir, writeFile } from '../support/tmp';

const DIAGRAM =
  '<html><head></head><body><svg viewBox="0 0 960 600" role="img" aria-labelledby="a-title a-desc"><title id="a-title">Orders</title><desc id="a-desc">d</desc></svg></body></html>';
let root: string;
beforeEach(() => {
  root = makeTempDir();
});
afterEach(() => removeDir(root));

describe('a diagram of the session', () => {
  it('is found by the path its edit showed, whatever the name', async () => {
    writeFile(root, 'docs/diagrams/überblick (2).html', DIAGRAM);
    const found = await diagramFile(root, 'docs/diagrams/überblick (2).html');
    expect(found.file).toBe(path.join(root, 'docs', 'diagrams', 'überblick (2).html'));
    expect(found.info).toEqual({ title: 'Orders', width: 960, height: 600 });
    expect(found.html).toBe(DIAGRAM);
  });

  it('is refused when it is gone, is no diagram any more, or lies outside the folder', async () => {
    await expect(diagramFile(root, 'docs/gone.html')).rejects.toMatchObject({ code: 'not_found', message: 'gone.html was moved or deleted.' });
    writeFile(root, 'page.html', '<html><body><p>hi</p></body></html>');
    await expect(diagramFile(root, 'page.html')).rejects.toMatchObject({ code: 'not_a_diagram', message: "Couldn't find the diagram in page.html." });
    const outside = writeFile(path.dirname(root), `${path.basename(root)}-outside.html`, DIAGRAM);
    try {
      await expect(diagramFile(root, `../${path.basename(root)}-outside.html`)).rejects.toMatchObject({ code: 'not_a_diagram' });
    } finally {
      removeDir(outside);
    }
    writeFile(root, 'big.html', DIAGRAM + ' '.repeat(2 * 1024 * 1024));
    await expect(diagramFile(root, 'big.html')).rejects.toMatchObject({ code: 'not_a_diagram' });
    writeFile(root, 'folder.html/x.txt', 'x');
    await expect(diagramFile(root, 'folder.html')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('a picture of a diagram', () => {
  it('is twice the size, less when a side would pass 8,000 px', () => {
    expect(clipFor({ x: 32, y: 120, width: 960, height: 600 })).toEqual({ x: 32, y: 120, width: 960, height: 600, scale: 2 });
    expect(clipFor({ x: 0, y: 0, width: 6000, height: 1000 }).scale).toBeCloseTo(8000 / 6000, 5);
  });

  it('is named after its page', () => {
    expect(exportName('docs/diagrams/orders.html', 'png')).toBe('orders.png');
    expect(exportName('a.b.HTM', 'svg')).toBe('a.b.svg');
  });
});
