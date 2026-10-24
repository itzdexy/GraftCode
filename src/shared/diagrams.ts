import type { DiagramInfo } from './schemas/toolDisplay';

/**
 * Diagrams as the diagram-design skill writes them: one HTML page whose
 * figure is an inline <svg role="img"> labelled by two ids, "<slug>-title"
 * and "<slug>-desc". That contract is what tells a diagram from any other
 * page (a page with a logo has an svg too). Pure, so both processes use it
 * and it is tested without a browser.
 */

/** A page longer than this is not looked at. */
export const MAX_DIAGRAM_CHARS = 2 * 1024 * 1024;

const DEFAULT_WIDTH = 960;
const DEFAULT_HEIGHT = 600;
const MIN_SIDE = 100;
const MAX_SIDE = 8000;
const MAX_TITLE = 120;

/** The value of an attribute in a start tag, quoted either way; null when the tag has no such attribute. */
function attribute(tag: string, name: string): string | null {
  const found = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return found ? (found[1] ?? found[2] ?? '') : null;
}

interface Found {
  /** Where the svg's start tag begins and ends, and where the element ends (after its end tag). */
  start: number;
  tagEnd: number;
  end: number;
  tag: string;
}

/** Where an svg that starts at `tagEnd` (the end of its start tag) closes, counting the svgs nested in it; -1 when it never does. */
function closeOf(html: string, tag: string, tagEnd: number): number {
  if (tag.endsWith('/>')) return tagEnd;
  const marks = /<svg\b[^>]*>|<\/svg\s*>/gi;
  marks.lastIndex = tagEnd;
  let depth = 1;
  for (let mark = marks.exec(html); mark; mark = marks.exec(html)) {
    if (mark[0].startsWith('</')) depth--;
    else if (!mark[0].endsWith('/>')) depth++;
    if (depth === 0) return mark.index + mark[0].length;
  }
  return -1;
}

/**
 * The diagram of a page: its first <svg> with role="img", when that svg is
 * labelled by exactly two ids ending in -title and -desc. Null for every
 * other page.
 */
function findDiagram(html: string): Found | null {
  if (html.length > MAX_DIAGRAM_CHARS) return null;
  const starts = /<svg\b[^>]*>/gi;
  for (let start = starts.exec(html); start; start = starts.exec(html)) {
    const tag = start[0];
    if (attribute(tag, 'role')?.trim().toLowerCase() !== 'img') continue;
    const ids = (attribute(tag, 'aria-labelledby') ?? '').split(/\s+/).filter((id) => id.length > 0);
    if (ids.length !== 2 || !ids[0]?.endsWith('-title') || !ids[1]?.endsWith('-desc')) return null;
    const tagEnd = start.index + tag.length;
    return { start: start.index, tagEnd, end: closeOf(html, tag, tagEnd), tag };
  }
  return null;
}

export function isDiagramDocument(html: string): boolean {
  return findDiagram(html) !== null;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (whole, decimal?: string, hex?: string, name?: string) => {
    if (name !== undefined) return ENTITIES[name.toLowerCase()] ?? whole;
    const code = decimal !== undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hex ?? '', 16);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/** The text of the first <title> in a piece of markup, as a reader sees it; empty when there is none. */
function titleIn(markup: string): string {
  const found = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(markup);
  return found ? decodeEntities((found[1] ?? '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim() : '';
}

function side(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.min(MAX_SIDE, Math.max(MIN_SIDE, Math.round(value))) : fallback;
}

/**
 * What a card needs to show a diagram before it has loaded: its title (the
 * svg's own, else the page's, else the file's name) and the size its viewBox
 * gives. Null when the page is no diagram.
 */
export function diagramInfo(html: string, fileName: string): DiagramInfo | null {
  const found = findDiagram(html);
  if (!found) return null;
  const inside = found.end > 0 ? html.slice(found.tagEnd, found.end) : html.slice(found.tagEnd);
  const title = titleIn(inside) || titleIn(html) || fileName;
  const box = (attribute(found.tag, 'viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  const sized = box.length === 4 && box.every((n) => Number.isFinite(n));
  return {
    title: title.slice(0, MAX_TITLE),
    width: side(sized ? box[2] : undefined, DEFAULT_WIDTH),
    height: side(sized ? box[3] : undefined, DEFAULT_HEIGHT)
  };
}

/**
 * The diagram alone, as an SVG file: the svg element whole, with the SVG
 * namespace when it names none, and the rules of the page's own <style>
 * elements placed after its description so its classes and variables still
 * resolve. Fonts are named, not carried. Null when the page has no diagram,
 * or one that never closes.
 */
export function standaloneSvg(html: string): string | null {
  const found = findDiagram(html);
  if (!found || found.end < 0) return null;
  const css: string[] = [];
  const styles = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
  for (let style = styles.exec(html); style; style = styles.exec(html)) {
    // A style inside the diagram travels with it already.
    if (style.index < found.start || style.index >= found.end) css.push(style[1] ?? '');
  }
  const tag = attribute(found.tag, 'xmlns') === null ? found.tag.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"') : found.tag;
  const body = html.slice(found.tagEnd, found.end);
  if (css.length === 0) return tag + body;
  // After the description (or the title), which have to come first for a reader's tools; never inside an svg nested further down.
  const nested = body.search(/<svg\b/i);
  const head = nested < 0 ? body : body.slice(0, nested);
  const after = /<\/desc\s*>/i.exec(head) ?? /<\/title\s*>/i.exec(head);
  const at = after ? after.index + after[0].length : 0;
  const rules = `<style><![CDATA[${css.join('\n').replace(/\]\]>/g, ']]]]><![CDATA[>')}]]></style>`;
  return tag + body.slice(0, at) + rules + body.slice(at);
}
