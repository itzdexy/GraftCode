import type { Nodes, PhrasingContent, Table } from 'mdast';
import { chatImage, parseMarkdown, safeHref, tableCells, type DocumentAssets } from './markdown';

/**
 * Markdown as a page to print. Everything a model wrote is escaped: raw HTML
 * shows as text, a link is kept only when it is a web or mail address, and a
 * picture only when it is one of the chat's own (embedded as data). The
 * policy in the page forbids scripts and loading anything at all.
 */

/** What the page may load: pictures placed in it and its own styles. No scripts, nothing from the network. */
export const PAGE_POLICY = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";

const STYLE = `@page { margin: 18mm; }
body { font: 11pt/1.5 "Segoe UI", system-ui, sans-serif; color: #1f2328; }
h1 { font-size: 20pt; } h2 { font-size: 15pt; } h3 { font-size: 12.5pt; }
h1, h2, h3, h4 { line-height: 1.25; break-after: avoid; }
code, pre { font: 9.5pt/1.45 Consolas, "Cascadia Mono", monospace; }
pre { background: #f4f5f7; padding: 8pt; white-space: pre-wrap; }
table { border-collapse: collapse; } th, td { border: 0.5pt solid #999; padding: 3pt 6pt; text-align: left; }
blockquote { margin-left: 0; padding-left: 10pt; border-left: 2pt solid #bbb; color: #555; }
img { max-width: 100%; } pre, table, img { break-inside: avoid; }
a { color: #0b57d0; }`;

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

interface Context {
  assets: DocumentAssets;
  /** Where reference-style links and pictures point, by their identifier. */
  definitions: Map<string, string>;
  /** Inside a tight list item a paragraph is the item's own text, not a block. */
  tight: boolean;
}

function children(node: Nodes, ctx: Context, separator = ''): string {
  return 'children' in node ? (node.children as Nodes[]).map((child) => render(child, ctx)).join(separator) : '';
}

function link(url: string, inner: string): string {
  const href = safeHref(url);
  return href ? `<a href="${escape(href)}">${inner}</a>` : inner;
}

function image(url: string, alt: string, ctx: Context): string {
  const own = chatImage(url, ctx.assets);
  if (own) return `<img src="data:${escape(own.mime)};base64,${own.data.toString('base64')}" alt="${escape(alt)}">`;
  // A picture from the web is never loaded: its name stays, as a link when it has a safe address.
  return link(url, escape(alt.length > 0 ? alt : url));
}

function table(node: Table, ctx: Context): string {
  const cell = (tag: 'th' | 'td', content: PhrasingContent[], index: number): string => {
    const align = node.align?.[index];
    return `<${tag}${align ? ` style="text-align: ${align}"` : ''}>${content.map((child) => render(child, ctx)).join('')}</${tag}>`;
  };
  const [head, ...body] = tableCells(node);
  const header = head ? `<thead><tr>${head.map((c, i) => cell('th', c, i)).join('')}</tr></thead>` : '';
  const rows = body.map((row) => `<tr>${row.map((c, i) => cell('td', c, i)).join('')}</tr>`).join('');
  return `<table>${header}<tbody>${rows}</tbody></table>`;
}

function render(node: Nodes, ctx: Context): string {
  switch (node.type) {
    case 'root':
      return children(node, ctx, '\n');
    // Inside a heading or a paragraph nothing is a block of its own: a tag written mid-sentence stays in the sentence.
    case 'heading':
      return `<h${String(node.depth)}>${children(node, { ...ctx, tight: true })}</h${String(node.depth)}>`;
    case 'paragraph':
      return ctx.tight ? children(node, ctx) : `<p>${children(node, { ...ctx, tight: true })}</p>`;
    case 'text':
      return escape(node.value);
    case 'emphasis':
      return `<em>${children(node, ctx)}</em>`;
    case 'strong':
      return `<strong>${children(node, ctx)}</strong>`;
    case 'delete':
      return `<del>${children(node, ctx)}</del>`;
    case 'inlineCode':
      return `<code>${escape(node.value)}</code>`;
    case 'code':
      return `<pre><code>${escape(node.value)}</code></pre>`;
    case 'break':
      return '<br>';
    case 'thematicBreak':
      return '<hr>';
    case 'blockquote':
      return `<blockquote>${children(node, { ...ctx, tight: false }, '\n')}</blockquote>`;
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul';
      const start = node.ordered && typeof node.start === 'number' && node.start !== 1 ? ` start="${String(node.start)}"` : '';
      return `<${tag}${start}>${children(node, { ...ctx, tight: node.spread !== true }, '\n')}</${tag}>`;
    }
    case 'listItem': {
      const box = node.checked === true ? '☑ ' : node.checked === false ? '☐ ' : '';
      return `<li>${box}${children(node, { ...ctx, tight: ctx.tight && node.spread !== true }, '\n')}</li>`;
    }
    case 'table':
      return table(node, { ...ctx, tight: true });
    case 'link':
      return link(node.url, children(node, ctx));
    case 'linkReference':
      return link(ctx.definitions.get(node.identifier) ?? '', children(node, ctx));
    case 'image':
      return image(node.url, node.alt ?? '', ctx);
    case 'imageReference':
      return image(ctx.definitions.get(node.identifier) ?? '', node.alt ?? '', ctx);
    case 'html':
      // Raw HTML is shown, never run: it is what a model wrote.
      return ctx.tight ? escape(node.value) : `<p>${escape(node.value)}</p>`;
    case 'footnoteReference':
      return `<sup>[${escape(node.identifier)}]</sup>`;
    case 'footnoteDefinition':
      return `<p><sup>[${escape(node.identifier)}]</sup> ${children(node, { ...ctx, tight: true }, ' ')}</p>`;
    default:
      // Definitions were read up front; anything else has nothing to show.
      return '';
  }
}

function definitionsOf(node: Nodes, found = new Map<string, string>()): Map<string, string> {
  if (node.type === 'definition') found.set(node.identifier, node.url);
  if ('children' in node) for (const child of node.children as Nodes[]) definitionsOf(child, found);
  return found;
}

export function markdownToHtml(markdown: string, options: { title: string; assets: DocumentAssets }): string {
  const tree = parseMarkdown(markdown);
  const body = render(tree, { assets: options.assets, definitions: definitionsOf(tree), tight: false });
  return [
    '<!doctype html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${PAGE_POLICY}">`,
    `<title>${escape(options.title)}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    `<body>${body}</body>`,
    '</html>'
  ].join('\n');
}
