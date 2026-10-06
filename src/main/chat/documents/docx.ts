import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type ILevelsOptions,
  type IParagraphOptions,
  type ParagraphChild
} from 'docx';
import type { BlockContent, DefinitionContent, List, Nodes, PhrasingContent, Table as MarkdownTable } from 'mdast';
import { imageSize } from './imageSize';
import { chatImage, parseMarkdown, safeHref, tableCells, type DocumentAssets } from './markdown';

/**
 * Markdown as a text document (.docx). Headings, emphasis, lists, quotes,
 * code, tables, links and the chat's own pictures keep their shape; raw HTML
 * is text, and a link that is not a web or mail address is only its words.
 */

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
/** Set on the document, so it does not open in whatever serif face the app falls back to. */
const FACE = 'Calibri';
const MONO = 'Consolas';
const CODE_FILL = 'F4F5F7';
/** A picture is never wider than the text column. */
const MAX_IMAGE_WIDTH = 600;
const LIST_LEVELS = 6;

interface Marks {
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
  link?: boolean;
}

interface Context {
  assets: DocumentAssets;
  definitions: Map<string, string>;
  /** One numbering for each numbered list, so each counts from where its text says ("2." after a block goes on at 2). */
  numberings: Array<{ reference: string; levels: ILevelsOptions[] }>;
}

type Block = Paragraph | Table;
type Shape = Omit<IParagraphOptions, 'children' | 'text'>;

function run(text: string, marks: Marks, mono = false): TextRun {
  return new TextRun({
    text,
    ...(marks.bold ? { bold: true } : {}),
    ...(marks.italics ? { italics: true } : {}),
    ...(marks.strike ? { strike: true } : {}),
    ...(marks.link ? { style: 'Hyperlink' } : {}),
    ...(mono ? { font: MONO, shading: { type: ShadingType.CLEAR, fill: CODE_FILL, color: 'auto' } } : {})
  });
}

function picture(url: string, alt: string, marks: Marks, ctx: Context): ParagraphChild[] {
  const own = chatImage(url, ctx.assets);
  const size = own ? imageSize(own.data) : null;
  const type = own?.mime === 'image/png' ? 'png' : own?.mime === 'image/jpeg' ? 'jpg' : own?.mime === 'image/gif' ? 'gif' : null;
  if (own && size && type && size.width > 0 && size.height > 0) {
    const scale = Math.min(1, MAX_IMAGE_WIDTH / size.width);
    return [new ImageRun({ type, data: own.data, transformation: { width: Math.round(size.width * scale), height: Math.round(size.height * scale) }, altText: { name: alt || url, description: alt, title: alt } })];
  }
  // A picture that is not the chat's own is never fetched: its name stays, as a link when its address is safe.
  return linked(url, [run(alt.length > 0 ? alt : url, marks)], marks, ctx);
}

function linked(url: string, plain: ParagraphChild[], marks: Marks, ctx: Context, children?: PhrasingContent[]): ParagraphChild[] {
  const href = safeHref(url);
  if (!href) return plain;
  return [new ExternalHyperlink({ link: href, children: children ? inline(children, { ...marks, link: true }, ctx) : plain })];
}

function inline(nodes: PhrasingContent[], marks: Marks, ctx: Context): ParagraphChild[] {
  return nodes.flatMap((node): ParagraphChild[] => {
    switch (node.type) {
      case 'text':
        return [run(node.value, marks)];
      case 'strong':
        return inline(node.children, { ...marks, bold: true }, ctx);
      case 'emphasis':
        return inline(node.children, { ...marks, italics: true }, ctx);
      case 'delete':
        return inline(node.children, { ...marks, strike: true }, ctx);
      case 'inlineCode':
        return [run(node.value, marks, true)];
      case 'break':
        return [new TextRun({ break: 1 })];
      case 'link':
        return linked(node.url, inline(node.children, marks, ctx), marks, ctx, node.children);
      case 'linkReference':
        return linked(ctx.definitions.get(node.identifier) ?? '', inline(node.children, marks, ctx), marks, ctx, node.children);
      case 'image':
        return picture(node.url, node.alt ?? '', marks, ctx);
      case 'imageReference':
        return picture(ctx.definitions.get(node.identifier) ?? '', node.alt ?? '', marks, ctx);
      case 'html':
        // Raw HTML is shown as the text it is.
        return [run(node.value, marks)];
      case 'footnoteReference':
        return [run(`[${node.identifier}]`, marks)];
      default:
        return [];
    }
  });
}

function codeBlock(value: string, shape: Shape): Paragraph {
  const lines = value.split('\n');
  return new Paragraph({
    ...shape,
    spacing: { after: 140 },
    shading: { type: ShadingType.CLEAR, fill: CODE_FILL, color: 'auto' },
    children: lines.map((line, i) => new TextRun({ text: line, font: MONO, size: 19, ...(i > 0 ? { break: 1 } : {}) }))
  });
}

function table(node: MarkdownTable, ctx: Context): Table {
  const alignment = (index: number) => {
    const align = node.align?.[index];
    return align === 'center' ? AlignmentType.CENTER : align === 'right' ? AlignmentType.RIGHT : AlignmentType.LEFT;
  };
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: tableCells(node).map(
      (row, rowIndex) =>
        new TableRow({
          tableHeader: rowIndex === 0,
          children: row.map((cell, i) => new TableCell({ children: [new Paragraph({ alignment: alignment(i), children: inline(cell, rowIndex === 0 ? { bold: true } : {}, ctx) })] }))
        })
    )
  });
}

/** The numbering of one numbered list: decimal on every level, counting from `start` on the level the list is at. */
function numbered(depth: number, start: number): ILevelsOptions[] {
  return Array.from({ length: LIST_LEVELS }, (_, level) => ({
    level,
    format: LevelFormat.DECIMAL,
    text: `%${String(level + 1)}.`,
    alignment: AlignmentType.START,
    start: level === depth ? start : 1,
    style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } }
  }));
}

function list(node: List, level: number, ctx: Context): Block[] {
  const depth = Math.min(level, LIST_LEVELS - 1);
  let marker: Shape = { bullet: { level: depth } };
  if (node.ordered) {
    const reference = `numbered-${String(ctx.numberings.length + 1)}`;
    ctx.numberings.push({ reference, levels: numbered(depth, node.start ?? 1) });
    marker = { numbering: { reference, level: depth } };
  }
  return node.children.flatMap((item): Block[] => {
    const box = item.checked === true ? '☑ ' : item.checked === false ? '☐ ' : '';
    let marked = false;
    return item.children.flatMap((child): Block[] => {
      if (child.type === 'list') return list(child, level + 1, ctx);
      if (child.type === 'paragraph' && !marked) {
        marked = true;
        // Space after each item that is dropped between neighbours of one style: the items sit together, and whatever follows the list has room.
        return [new Paragraph({ ...marker, spacing: { after: 140 }, contextualSpacing: true, children: [...(box ? [run(box, {})] : []), ...inline(child.children, {}, ctx)] })];
      }
      // Anything else inside an item (a second paragraph, code, a quote) sits under it, indented.
      return blocks([child], { indent: { left: 720 * (depth + 1) } }, ctx);
    });
  });
}

function blocks(nodes: Array<BlockContent | DefinitionContent>, shape: Shape, ctx: Context): Block[] {
  return nodes.flatMap((node): Block[] => {
    switch (node.type) {
      case 'heading':
        return [new Paragraph({ ...shape, heading: HEADINGS[node.depth - 1] ?? HeadingLevel.HEADING_6, children: inline(node.children, {}, ctx) })];
      case 'paragraph':
        return [new Paragraph({ ...shape, spacing: { after: 140 }, children: inline(node.children, {}, ctx) })];
      case 'code':
        return [codeBlock(node.value, shape)];
      case 'blockquote':
        return blocks(node.children, { ...shape, indent: { left: 360 }, border: { left: { style: BorderStyle.SINGLE, size: 12, space: 8, color: 'BBBBBB' } } }, ctx);
      case 'list':
        return list(node, 0, ctx);
      case 'table':
        return [table(node, ctx), new Paragraph({ children: [] })];
      case 'thematicBreak':
        return [new Paragraph({ ...shape, border: { bottom: { style: BorderStyle.SINGLE, size: 6, space: 1, color: '999999' } }, children: [] })];
      case 'html':
        return [new Paragraph({ ...shape, children: [run(node.value, {})] })];
      case 'footnoteDefinition':
        return blocks(node.children, shape, ctx);
      default:
        // Definitions were read up front.
        return [];
    }
  });
}

function definitionsOf(node: Nodes, found = new Map<string, string>()): Map<string, string> {
  if (node.type === 'definition') found.set(node.identifier, node.url);
  if ('children' in node) for (const child of node.children as Nodes[]) definitionsOf(child, found);
  return found;
}

export function markdownToDocx(markdown: string, options: { title: string; assets: DocumentAssets }): Promise<Buffer> {
  const tree = parseMarkdown(markdown);
  const ctx: Context = { assets: options.assets, definitions: definitionsOf(tree), numberings: [] };
  const children = blocks(tree.children as Array<BlockContent | DefinitionContent>, {}, ctx);
  const document = new Document({
    title: options.title,
    creator: 'Graft',
    styles: { default: { document: { run: { font: FACE, size: 22 } } } },
    numbering: { config: ctx.numberings },
    sections: [{ children: children.length > 0 ? children : [new Paragraph({ children: [] })] }]
  });
  return Packer.toBuffer(document);
}
