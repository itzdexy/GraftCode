/** Larger drawings stay as code: a data: address that long is slow to lay out. */
const MAX_SVG_CHARS = 400_000;

/** What may stand before the <svg> tag of a drawing that is nothing else: an XML declaration, comments, a doctype. */
const PROLOG = /^(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype[^>]*>\s*)?$/i;

/**
 * A finished SVG drawing in a code block, as an address an <img> can show;
 * null when the code is not one. An image runs no script and loads nothing
 * from outside, so a drawing from anywhere is safe to show this way.
 */
export function svgImage(code: string, language: string | null): string | null {
  const lang = (language ?? '').toLowerCase();
  if (lang !== 'svg' && lang !== 'xml' && lang !== 'html' && lang !== '') return null;
  const text = code.trim();
  const start = text.search(/<svg[\s>]/i);
  if (start === -1 || text.length > MAX_SVG_CHARS || !/<\/svg>$/i.test(text) || !PROLOG.test(text.slice(0, start))) return null;
  let svg = text.slice(start);
  // An image needs the namespace that a browser tab would let slide.
  if (!/^<svg[^>]*\sxmlns\s*=/i.test(svg)) svg = svg.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
