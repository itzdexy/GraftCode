import fs from 'node:fs';
import path from 'node:path';

/**
 * What the preview server adds to a page as it serves it. The file on disk
 * is never changed.
 *
 * Fonts: a preview has no network, and pages such as the ones the
 * diagram-design skill writes ask a font service for theirs. A page that
 * names Geist, Geist Mono or Instrument Serif gets the copies Graft ships
 * (resources/fonts), as data: addresses, which the preview's content policy
 * allows and which need no request at all.
 *
 * Size: a frame can't be measured from outside its origin, so a page asked
 * for with ?report=size tells its parent how large it is.
 */

export type FontFile = 'Geist.woff2' | 'GeistMono.woff2' | 'InstrumentSerif-Regular.woff2' | 'InstrumentSerif-Italic.woff2';

/** A bundled font as base64; null when the file is not there. */
export type FontReader = (file: FontFile) => string | null;

/** Reads each font once, then from memory. Without a folder, or without the file, there is no font and the page falls back. */
export function fontReader(fontsDir: string | null): FontReader {
  const read = new Map<FontFile, string | null>();
  return (file) => {
    const known = read.get(file);
    if (known !== undefined) return known;
    let data: string | null = null;
    if (fontsDir !== null) {
      try {
        data = fs.readFileSync(path.join(fontsDir, file)).toString('base64');
      } catch {
        // rocky: an install without this file shows the page in the computer's own fonts; nothing else depends on it.
        data = null;
      }
    }
    read.set(file, data);
    return data;
  };
}

/** The faces a page may be given, in the order they are written. `named` finds the family's name in the page. */
const FACES: ReadonlyArray<{ family: string; named: RegExp; file: FontFile; style: 'normal' | 'italic'; weight: string }> = [
  { family: 'Geist', named: /Geist(?! Mono)/, file: 'Geist.woff2', style: 'normal', weight: '100 900' },
  { family: 'Geist Mono', named: /Geist Mono/, file: 'GeistMono.woff2', style: 'normal', weight: '100 900' },
  { family: 'Instrument Serif', named: /Instrument Serif/, file: 'InstrumentSerif-Regular.woff2', style: 'normal', weight: '400' },
  { family: 'Instrument Serif', named: /Instrument Serif/, file: 'InstrumentSerif-Italic.woff2', style: 'italic', weight: '400' }
];

function fontStyle(html: string, fonts: FontReader): string {
  const rules = FACES.flatMap((face) => {
    if (!face.named.test(html)) return [];
    const data = fonts(face.file);
    return data === null
      ? []
      : [`@font-face{font-family:'${face.family}';font-style:${face.style};font-weight:${face.weight};font-display:block;src:url(data:font/woff2;base64,${data}) format('woff2')}`];
  });
  return rules.length > 0 ? `<style data-graft-fonts>${rules.join('')}</style>` : '';
}

/** Where a page's own head begins; for a page without one, the earliest place that keeps a doctype first. */
function headStart(html: string): number {
  for (const opening of [/<head\b[^>]*>/i, /<html\b[^>]*>/i, /<!doctype\b[^>]*>/i]) {
    const found = opening.exec(html);
    if (found) return found.index + found[0].length;
  }
  return 0;
}

/**
 * Tells the page's parent how large the page is, when it has loaded and when
 * its size changes. The parent takes it as a hint from an untrusted page: it
 * checks where the message came from and what it holds.
 */
export const SIZE_REPORTER =
  "<script data-graft-size>(()=>{const s=()=>parent.postMessage({graftPreview:{width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight}},'*');addEventListener('load',s);new ResizeObserver(s).observe(document.documentElement)})()</script>";

/** The page as the preview server sends it: with the bundled fonts it names, and with the size report when that was asked for. */
export function withPreviewExtras(html: string, options: { fonts: FontReader; reportSize: boolean }): string {
  let page = html;
  const style = fontStyle(page, options.fonts);
  if (style.length > 0) {
    const at = headStart(page);
    page = page.slice(0, at) + style + page.slice(at);
  }
  if (options.reportSize) {
    const end = page.toLowerCase().lastIndexOf('</body>');
    page = end < 0 ? page + SIZE_REPORTER : page.slice(0, end) + SIZE_REPORTER + page.slice(end);
  }
  return page;
}
