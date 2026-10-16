import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ARTIFACT_CSP, ArtifactServer } from '../../src/main/artifacts/artifacts';
import { fontReader, SIZE_REPORTER, withPreviewExtras } from '../../src/main/artifacts/previewExtras';
import { makeTempDir, removeDir, writeFile } from '../support/tmp';

const FONTS = path.resolve(__dirname, '../../resources/fonts');
const fake: Parameters<typeof withPreviewExtras>[1]['fonts'] = (file) => `B64(${file})`;
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => removeDir(dir)));

describe('fonts for previews', () => {
  it('are the four files, with their licence', () => {
    for (const f of ['Geist.woff2', 'GeistMono.woff2', 'InstrumentSerif-Regular.woff2', 'InstrumentSerif-Italic.woff2']) {
      expect(fs.readFileSync(path.join(FONTS, f)).subarray(0, 4).toString('latin1')).toBe('wOF2');
    }
    expect(fs.readFileSync(path.join(FONTS, 'OFL.txt'), 'utf8')).toContain('SIL OPEN FONT LICENSE');
  });

  it('are added for the families a page names, right after its head', () => {
    const html = "<html><head lang='en'><style>body{font-family:'Geist',sans-serif}h1{font-family:'Instrument Serif'}code{font-family:'Geist Mono'}</style></head><body></body></html>";
    const out = withPreviewExtras(html, { fonts: fake, reportSize: false });
    expect(out.startsWith("<html><head lang='en'><style data-graft-fonts>@font-face{font-family:'Geist';font-style:normal;font-weight:100 900;font-display:block;src:url(data:font/woff2;base64,B64(Geist.woff2)) format('woff2')}")).toBe(true);
    expect(out.match(/@font-face/g)).toHaveLength(4);
    expect(out).toContain("font-family:'Instrument Serif';font-style:italic;font-weight:400;font-display:block;src:url(data:font/woff2;base64,B64(InstrumentSerif-Italic.woff2))");
    expect(out.endsWith('</style></head><body></body></html>')).toBe(true);
  });

  it('add only what is named, and nothing where nothing is', () => {
    const mono = withPreviewExtras('<head></head><p style="font-family:\'Geist Mono\'">x</p>', { fonts: fake, reportSize: false });
    expect(mono.match(/@font-face/g)).toHaveLength(1);
    expect(mono).toContain("font-family:'Geist Mono'");
    expect(withPreviewExtras('<p style="font-family:\'Geist\'">x</p>', { fonts: fake, reportSize: false }).startsWith('<style data-graft-fonts>')).toBe(true);
    const plain = '<html><head></head><body><p>hi</p></body></html>';
    expect(withPreviewExtras(plain, { fonts: fake, reportSize: false })).toBe(plain);
    expect(withPreviewExtras('<head></head><p style="font-family:\'Geist\'">x</p>', { fonts: fontReader(null), reportSize: false })).not.toContain('data-graft-fonts');
    expect(fontReader(path.join(FONTS, 'gone'))('Geist.woff2')).toBeNull();
  });

  it('add the size report only when asked, before the end of the body', () => {
    expect(withPreviewExtras('<html><body><p>hi</p></body></html>', { fonts: fake, reportSize: true })).toBe(`<html><body><p>hi</p>${SIZE_REPORTER}</body></html>`);
    expect(withPreviewExtras('<p>hi</p>', { fonts: fake, reportSize: true })).toBe(`<p>hi</p>${SIZE_REPORTER}`);
  });
});

describe('the preview server', () => {
  it('serves a page with its extras, under any name, and leaves the file as it was', async () => {
    const root = makeTempDir();
    dirs.push(root);
    const html = '<html><head></head><body style="font-family:\'Geist\'"><script src="https://example.com/x.js"></script></body></html>';
    const file = writeFile(root, 'New folder (3)/überblick.html', html);
    writeFile(root, 'New folder (3)/other.html', 'x');
    const server = new ArtifactServer({ fontsDir: FONTS });
    const url = server.urlForFile(file);
    const sized = await server.respond(`${url}?report=size`);
    expect(sized.status).toBe(200);
    expect(sized.headers.get('content-security-policy')).toBe(ARTIFACT_CSP);
    const body = await sized.text();
    expect(body).toContain('<style data-graft-fonts>');
    expect(body).toContain(SIZE_REPORTER);
    expect(await (await server.respond(url)).text()).not.toContain('data-graft-size');
    expect((await server.respond(url.replace(/[^/]+$/, 'other.html'))).status).toBe(403);
    expect(fs.readFileSync(file, 'utf8')).toBe(html);
    // A token belongs to the server that made it.
    expect((await new ArtifactServer().respond(new ArtifactServer().urlForFile(file))).status).toBe(404);
  });
});
