import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { diagramInfo, isDiagramDocument, standaloneSvg } from '../../src/shared/diagrams';

const ASSETS = path.resolve(__dirname, '../../resources/skills/diagram-design/assets');
const page = (body: string, head = ''): string => `<!DOCTYPE html><html><head>${head}</head><body>${body}</body></html>`;
const SVG = '<svg viewBox="0 0 1200 640" role="img" aria-labelledby="flow-title flow-desc"><title id="flow-title">Sign-in &amp; refresh</title><desc id="flow-desc">How a token is renewed.</desc><rect/></svg>';

describe('what counts as a diagram', () => {
  it('takes every template and example the skill ships', () => {
    const shipped = fs.readdirSync(ASSETS).filter((f) => /^(template|example-).*\.html$/.test(f));
    expect(shipped.length).toBeGreaterThan(200);
    expect(shipped.filter((f) => !isDiagramDocument(fs.readFileSync(path.join(ASSETS, f), 'utf8')))).toEqual([]);
  });

  it('leaves other pages alone', () => {
    expect(isDiagramDocument(fs.readFileSync(path.join(ASSETS, 'icons.html'), 'utf8'))).toBe(false);
    expect(isDiagramDocument(page('<svg role="img" aria-label="Logo"><path/></svg>'))).toBe(false);
    expect(isDiagramDocument(page('<svg role="img" aria-labelledby="logo-name"><path/></svg>'))).toBe(false);
    expect(isDiagramDocument(page('<svg aria-labelledby="a-title a-desc"><path/></svg>'))).toBe(false);
    expect(isDiagramDocument('')).toBe(false);
    expect(isDiagramDocument(page(SVG) + ' '.repeat(2 * 1024 * 1024))).toBe(false);
  });

  it('reads the title and the size, and falls back when they are missing', () => {
    expect(diagramInfo(page(SVG), 'flow.html')).toEqual({ title: 'Sign-in & refresh', width: 1200, height: 640 });
    const bare = '<svg role="img" aria-labelledby="a-title a-desc"><desc id="a-desc">d</desc></svg>';
    expect(diagramInfo(page(bare, '<title>  Billing\n flow </title>'), 'x.html')).toEqual({ title: 'Billing flow', width: 960, height: 600 });
    expect(diagramInfo(page(bare), 'billing-flow.html')).toEqual({ title: 'billing-flow.html', width: 960, height: 600 });
    expect(diagramInfo(page(SVG.replace('0 0 1200 640', '0 0 90000 4')), 'x.html')).toMatchObject({ width: 8000, height: 100 });
    expect(diagramInfo(page(SVG.replace('Sign-in &amp; refresh', 'T'.repeat(300))), 'x.html')?.title).toHaveLength(120);
    expect(diagramInfo(page('<p>no</p>'), 'x.html')).toBeNull();
  });
});

describe('a diagram on its own', () => {
  it("is the svg, whole, with the page's style rules after its description", () => {
    const nested = SVG.replace('<rect/>', '<svg x="4"><circle/></svg><rect/>');
    const out = standaloneSvg(page(`<div>${nested}</div><svg aria-hidden="true"></svg>`, '<style>:root{--color-paper:#f5f5f5}</style><style>.n{fill:var(--color-paper)}</style>'));
    expect(out?.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 640"')).toBe(true);
    expect(out?.endsWith('<svg x="4"><circle/></svg><rect/></svg>')).toBe(true);
    expect(out).toContain('</desc><style><![CDATA[:root{--color-paper:#f5f5f5}\n.n{fill:var(--color-paper)}]]></style>');
  });

  it('keeps an xmlns it already has, and is nothing without a diagram', () => {
    const template = fs.readFileSync(path.join(ASSETS, 'template.html'), 'utf8');
    expect(standaloneSvg(template)?.match(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g)).toHaveLength(1);
    expect(standaloneSvg(page('<p>no</p>'))).toBeNull();
  });
});
