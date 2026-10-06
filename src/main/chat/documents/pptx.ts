import type { List, Nodes } from 'mdast';
import PptxGenJS from 'pptxgenjs';
import { imageSize } from './imageSize';
import { chatImage, parseMarkdown, tableCells, type DocumentAssets } from './markdown';

/**
 * Markdown as slides (.pptx). A line holding only --- starts the next slide;
 * a slide's first heading is its title, its list items are bullets, its
 * first table is a table, a paragraph starting with "Note:" is the
 * speaker's note, and its first picture (one of the chat's own) sits on the
 * right half.
 */

export const MAX_SLIDES = 100;

export interface Slide {
  title: string;
  bullets: Array<{ text: string; level: number }>;
  paragraphs: string[];
  /** The address of the slide's first picture as written; only a file of the chat is ever shown. */
  image: string | null;
  notes: string;
  /** The slide's first table, with how each column is aligned. A second table is kept as lines of text. */
  table: { rows: string[][]; align: Array<'left' | 'center' | 'right'> } | null;
}

/** The words of a node, without its pictures. A hard break is a new line, and so is each block inside a block (the paragraphs of a quote, the items of a list). */
function plain(node: Nodes): string {
  if (node.type === 'image' || node.type === 'imageReference') return '';
  if (node.type === 'break') return '\n';
  if ('value' in node) return node.value;
  if (!('children' in node)) return '';
  const apart = node.type === 'blockquote' || node.type === 'list' || node.type === 'listItem' || node.type === 'footnoteDefinition';
  return (node.children as Nodes[]).map(plain).join(apart ? '\n' : '');
}

function firstImage(node: Nodes): string | null {
  if (node.type === 'image') return node.url;
  for (const child of 'children' in node ? (node.children as Nodes[]) : []) {
    const found = firstImage(child);
    if (found !== null) return found;
  }
  return null;
}

function bulletsOf(list: List, level: number, out: Slide['bullets']): void {
  for (const item of list.children) {
    const text = item.children
      .filter((child) => child.type !== 'list')
      .map(plain)
      .join(' ')
      .trim();
    if (text.length > 0) out.push({ text, level });
    for (const child of item.children) if (child.type === 'list') bulletsOf(child, level + 1, out);
  }
}

function slideOf(part: string): Slide | null {
  const slide: Slide = { title: '', bullets: [], paragraphs: [], image: null, notes: '', table: null };
  let titled = false;
  for (const node of parseMarkdown(part).children) {
    slide.image ??= firstImage(node);
    if (node.type === 'heading' && !titled) {
      titled = true;
      slide.title = plain(node).trim();
    } else if (node.type === 'list') {
      bulletsOf(node, 0, slide.bullets);
    } else if (node.type === 'table') {
      const rows = tableCells(node).map((row) => row.map((cell) => cell.map(plain).join('').trim()));
      if (slide.table === null) slide.table = { rows, align: (rows[0] ?? []).map((_, i) => node.align?.[i] ?? 'left') };
      else for (const row of rows) slide.paragraphs.push(row.join(' | '));
    } else {
      const text = plain(node).trim();
      const note = /^note:\s*/i.exec(text);
      if (note) slide.notes = [slide.notes, text.slice(note[0].length)].filter((s) => s.length > 0).join('\n');
      else if (text.length > 0) slide.paragraphs.push(text);
    }
  }
  // Without a heading, the first line of text names the slide.
  if (!titled && slide.paragraphs.length > 0) slide.title = slide.paragraphs.shift() ?? '';
  const empty = slide.title.length === 0 && slide.bullets.length === 0 && slide.paragraphs.length === 0 && slide.image === null && slide.notes.length === 0 && slide.table === null;
  return empty ? null : slide;
}

export function splitSlides(markdown: string): Slide[] {
  const parts: string[][] = [[]];
  let fence: string | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const mark = /^\s*(```|~~~)/.exec(line)?.[1] ?? null;
    if (mark && fence === null) fence = mark;
    else if (mark && mark === fence) fence = null;
    if (fence === null && line.trim() === '---') parts.push([]);
    else parts.at(-1)?.push(line);
  }
  return parts.flatMap((lines) => {
    const slide = slideOf(lines.join('\n'));
    return slide ? [slide] : [];
  });
}

const INK = '1F2328';
const MUTED = '57606A';
const RULE = 'D0D7DE';
const HEAD_FILL = 'F4F5F7';
const FACE = 'Segoe UI';
/** The slide is 13.33 x 7.5 in. */
const WIDTH = 13.33;
const MARGIN = 0.6;
const BODY_TOP = 1.5;
const BODY_HEIGHT = 5.4;
/** Pictures are measured in pixels; a slide in inches. */
const PIXELS_PER_INCH = 96;

export async function markdownToPptx(markdown: string, options: { title: string; assets: DocumentAssets }): Promise<Buffer> {
  const slides = splitSlides(markdown);
  if (slides.length > MAX_SLIDES) throw new Error(`A presentation can have up to ${String(MAX_SLIDES)} slides.`);
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = options.title;
  pptx.author = 'Graft';
  const full = WIDTH - MARGIN * 2;

  const blank: Slide = { title: options.title, bullets: [], paragraphs: [], image: null, notes: '', table: null };
  for (const [index, content] of (slides.length > 0 ? slides : [blank]).entries()) {
    const slide = pptx.addSlide();
    slide.background = { color: 'FFFFFF' };
    const picture = content.image ? chatImage(content.image, options.assets) : null;
    const size = picture ? imageSize(picture.data) : null;
    const shown = picture !== null && size !== null && size.width > 0 && size.height > 0;

    if (index === 0 && content.bullets.length === 0 && !shown && !content.table) {
      // The title slide: the title in the middle, anything else under it.
      slide.addText(content.title, { x: MARGIN, y: 2.3, w: full, h: 1.6, fontSize: 40, bold: true, align: 'center', valign: 'middle', color: INK, fontFace: FACE });
      if (content.paragraphs.length > 0) {
        slide.addText(content.paragraphs.join('\n'), { x: MARGIN, y: 4.0, w: full, h: 1.4, fontSize: 20, align: 'center', valign: 'top', color: MUTED, fontFace: FACE });
      }
    } else {
      slide.addText(content.title, { x: MARGIN, y: 0.4, w: full, h: 0.9, fontSize: 28, bold: true, valign: 'middle', color: INK, fontFace: FACE });
      const bodyWidth = shown ? full / 2 - 0.2 : full;
      const lines = [
        ...content.paragraphs.map((text) => ({ text, options: { breakLine: true } })),
        ...content.bullets.map((bullet) => ({ text: bullet.text, options: { bullet: true, indentLevel: bullet.level, breakLine: true } }))
      ];
      // Text is not measured here: above a table each line is given about a third of an inch.
      const textHeight = content.table ? Math.min(BODY_HEIGHT - 1.5, lines.length * 0.36 + 0.2) : BODY_HEIGHT;
      if (lines.length > 0) {
        slide.addText(lines, { x: MARGIN, y: BODY_TOP, w: bodyWidth, h: textHeight, fontSize: 18, valign: 'top', color: INK, fontFace: FACE, paraSpaceAfter: 6 });
      }
      if (content.table) {
        const { rows, align } = content.table;
        slide.addTable(
          rows.map((row, r) => row.map((text, c) => ({ text, options: { align: align[c] ?? 'left', ...(r === 0 ? { bold: true, fill: { color: HEAD_FILL } } : {}) } }))),
          {
            // In line with the text above it, which sits a tenth of an inch inside its box.
            x: MARGIN + 0.1,
            y: BODY_TOP + (lines.length > 0 ? textHeight + 0.1 : 0.1),
            w: bodyWidth - 0.2,
            // A long table gets smaller type before it runs off the slide.
            fontSize: rows.length > 14 ? 10 : rows.length > 8 ? 12 : 14,
            fontFace: FACE,
            color: INK,
            valign: 'middle',
            border: { type: 'solid', pt: 0.75, color: RULE }
          }
        );
      }
      if (shown) {
        // Fitted inside the right half, keeping its proportions, never larger than its own size.
        const boxWidth = full / 2 - 0.2;
        const scale = Math.min(boxWidth / (size.width / PIXELS_PER_INCH), BODY_HEIGHT / (size.height / PIXELS_PER_INCH), 1);
        const w = (size.width / PIXELS_PER_INCH) * scale;
        const h = (size.height / PIXELS_PER_INCH) * scale;
        const left = MARGIN + full / 2 + 0.2;
        slide.addImage({ data: `${picture.mime};base64,${picture.data.toString('base64')}`, x: left + (boxWidth - w) / 2, y: BODY_TOP + (BODY_HEIGHT - h) / 2, w, h });
      }
    }
    if (content.notes.length > 0) slide.addNotes(content.notes);
  }

  const written = await pptx.write({ outputType: 'nodebuffer' });
  return Buffer.isBuffer(written) ? written : Buffer.from(written as Uint8Array);
}
