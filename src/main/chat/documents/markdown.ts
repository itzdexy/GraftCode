import type { Nodes, PhrasingContent, Root, Table } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { writable } from './text';

/** What a document may take from its chat: the pictures made there, by file name. */
export interface DocumentAssets {
  image(name: string): { mime: string; data: Buffer } | null;
}

const LINE_BREAK_TAG = /^<br\s*\/?>$/i;

/**
 * Makes a tree safe to write as a document, and reads the one tag that is
 * worth reading. A character reference (&#12;) brings back a character the
 * formats forbid after the text itself was cleaned, so every text, address
 * and title in the tree is cleaned again. Raw HTML is shown as text, except
 * <br>, which models write inside table cells: that is a line break.
 */
function tidy(node: Nodes): void {
  const held = node as { type: string; value?: unknown; url?: unknown; alt?: unknown; title?: unknown };
  if (node.type === 'html' && LINE_BREAK_TAG.test(node.value.trim())) {
    held.type = 'break';
    delete held.value;
  }
  for (const key of ['value', 'url', 'alt', 'title'] as const) {
    const text = held[key];
    if (typeof text === 'string') held[key] = writable(text);
  }
  if ('children' in node) for (const child of node.children) tidy(child);
}

/** Markdown as a tree: CommonMark plus tables, strikethrough, task items and autolinks. */
export function parseMarkdown(text: string): Root {
  const tree = fromMarkdown(writable(text), { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  tidy(tree);
  return tree;
}

/**
 * The cells of a table, row by row, every row as wide as the heading row: a
 * short row is filled with empty cells and a long one cut, the way Markdown
 * reads tables. A file whose rows differ in width is one some apps refuse.
 */
export function tableCells(node: Table): PhrasingContent[][][] {
  const width = node.children[0]?.children.length ?? 0;
  return node.children.map((row) => Array.from({ length: width }, (_, i) => row.children[i]?.children ?? []));
}

/** A link a document may carry: web and mail addresses only. Anything else (javascript:, file:, data:) is dropped. */
export function safeHref(url: string): string | null {
  const trimmed = url.trim();
  return /^(https?:\/\/|mailto:)/i.test(trimmed) ? trimmed : null;
}

/**
 * The picture a Markdown image names, when it names a file of this chat.
 * Only a plain file name is ever looked up: no folders, no drive, no address,
 * so what a model writes can't reach a file outside the chat's own.
 */
export function chatImage(url: string, assets: DocumentAssets): { mime: string; data: Buffer } | null {
  let name = url.trim();
  try {
    name = decodeURIComponent(name);
  } catch {
    // Not percent-encoded: use it as written.
  }
  if (name.length === 0 || name.startsWith('.') || /[\\/:]/.test(name)) return null;
  return assets.image(name);
}
