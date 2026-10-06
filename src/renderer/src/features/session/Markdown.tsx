import type { ElementContent, Root, RootContent } from 'hast';
import { createContext, memo, useContext, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { SourceIndex } from '@shared/sources';
import { cn } from '../../lib/cn';
import { invoke } from '../../lib/ipc';
import { reportError } from '../../stores/toasts';
import { SiteIcon } from '../web/SearchResults';
import { CodeBlock } from './CodeBlock';
import { citationNote, citationState } from './sourcesModel';
import { healMarkdown, splitBlocks } from './streaming';

export function openLink(href: string): void {
  invoke('app:openExternal', { url: href }).catch((error: unknown) => reportError("Couldn't open the link", error));
}

/** What the conversation read and found on the web; null when it has no sources, and then no citation is marked. */
export const SourcesContext = createContext<SourceIndex | null>(null);

/**
 * A citation: a pill naming the site a claim came from. In a conversation
 * that used the web it also says whether the page was opened, only found by
 * a search, or neither, and one nobody opened or found has a dashed border.
 */
function Citation({ href, text, arriving }: { href: string; text: string; arriving: string }): ReactNode {
  const state = citationState(href, useContext(SourcesContext));
  const site = text.replace(/^www\./i, '');
  const note = state ? citationNote(state) : null;
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        openLink(href);
      }}
      title={note ? `${href}\n${note}` : href}
      aria-label={note ? `${site}: ${note}` : undefined}
      className={cn(
        arriving,
        'mx-2 inline-flex -translate-y-px items-center gap-4 rounded-full border bg-control px-6 py-px align-middle font-sans text-[0.75em] leading-[1.6] text-fg-secondary no-underline transition-ui hover:bg-hover hover:text-fg',
        state === 'unseen' ? 'border-dashed border-fg-faint' : 'border-transparent'
      )}
    >
      <SiteIcon url={href} size={11} />
      {site}
    </a>
  );
}

function textContent(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as { type?: string; value?: string; children?: unknown[] };
  if (n.type === 'text') return n.value ?? '';
  return (n.children ?? []).map(textContent).join('');
}

function childText(children: ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map((c) => childText(c as ReactNode)).join('');
  return '';
}

/** A link written as a citation: its text names the site it points to, e.g. [rolimons.com](https://www.rolimons.com/…). */
export function isCitation(href: string, text: string): boolean {
  const label = text.trim().toLowerCase().replace(/^www\./, '');
  if (!/^[a-z0-9][a-z0-9.-]{1,40}$/.test(label)) return false;
  try {
    const url = new URL(href);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    return url.hostname.toLowerCase().replace(/^www\./, '').includes(label);
  } catch {
    return false;
  }
}

const TABLE_DELIMITER = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

function cellCount(row: string): number {
  return row.split('|').filter((cell) => cell.trim().length > 0).length;
}

/**
 * Repairs tables models sometimes break: a header row glued to the line
 * before it ("### Lineup| Model | Status |") or right after a paragraph line
 * keeps the whole table from rendering. Code fences are left alone.
 */
export function tidyMarkdown(text: string): string {
  // "([site.com](url))" reads oddly once the link is a pill: drop parentheses around a lone citation.
  const cited = text.replace(/\(\s*(\[[a-z0-9][a-z0-9.-]{1,40}\]\(https?:\/\/[^)\s]+\))\s*\)/gi, '$1');
  if (!cited.includes('|')) return cited;
  const lines = cited.split('\n');
  const out: string[] = [];
  let fenced = false;
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const next = lines[i + 1];
    if (!fenced && next !== undefined && TABLE_DELIMITER.test(next)) {
      const pipe = line.indexOf('|');
      const before = pipe > 0 ? line.slice(0, pipe).trim() : '';
      if (before.length > 0 && cellCount(line.slice(pipe)) === cellCount(next)) {
        out.push(line.slice(0, pipe).trimEnd(), '', line.slice(pipe));
        return;
      }
      const previous = out.at(-1);
      if (pipe === 0 || line.trimStart().startsWith('|')) {
        if (previous !== undefined && previous.trim().length > 0 && !previous.trimStart().startsWith('|')) out.push('');
      }
    }
    out.push(line);
  });
  return out.join('\n');
}

/** Elements whose text stays in one piece while a reply streams: code keeps its spacing, a link its label. */
const KEEP_WHOLE = new Set(['pre', 'code', 'a']);

function wrapWords<T extends RootContent | ElementContent>(nodes: T[]): T[] {
  return nodes.flatMap((node): T[] => {
    if (node.type === 'text') {
      return node.value
        .split(/(\s+)/)
        .filter((part) => part.length > 0)
        .map((part): ElementContent =>
          /^\s+$/.test(part) ? { type: 'text', value: part } : { type: 'element', tagName: 'span', properties: { className: ['graft-word'] }, children: [{ type: 'text', value: part }] }
        ) as T[];
    }
    if (node.type === 'element' && !KEEP_WHOLE.has(node.tagName)) node.children = wrapWords(node.children);
    return [node];
  });
}

/**
 * While a reply streams, each word gets its own element, so a word that has
 * just arrived fades in (.graft-word) and the ones already there stay put.
 */
function fadeWords() {
  return (tree: Root): void => {
    tree.children = wrapWords(tree.children);
  };
}

function buildComponents(live: boolean): Components {
  // Inline code and links arrive as one piece, so they fade in whole.
  const arriving = live ? 'graft-word ' : '';
  return {
    pre({ node }) {
      const code = node?.children[0];
      const className =
        code && code.type === 'element' && Array.isArray(code.properties.className) ? code.properties.className.map(String) : [];
      const language = className.find((c) => c.startsWith('language-'))?.slice('language-'.length) ?? null;
      return <CodeBlock code={textContent(code).replace(/\n$/, '')} language={language} live={live} />;
    },
    code({ children }) {
      return <code className={`${arriving}rounded-xs border border-code-border bg-code-bg px-4 py-px font-mono text-[0.9em] text-code-fg`}>{children}</code>;
    },
    a({ href, children }) {
      if (!href) return <span>{children}</span>;
      const text = childText(children);
      if (isCitation(href, text)) return <Citation href={href} text={text} arriving={arriving.trim()} />;
      return (
        <a
          href={href}
          onClick={(e) => {
            e.preventDefault();
            openLink(href);
          }}
          className={`${arriving}text-link underline-offset-2 hover:underline`}
          title={href}
        >
          {children}
        </a>
      );
    },
    img({ src, alt }) {
      // Remote images are blocked by the CSP (no tracking pixels); show them as links.
      if (typeof src === 'string' && src.startsWith('data:image/')) return <img src={src} alt={alt ?? ''} className="max-w-full rounded-md" />;
      return typeof src === 'string' ? (
        <a
          href={src}
          onClick={(e) => {
            e.preventDefault();
            openLink(src);
          }}
          className="text-link hover:underline"
        >
          {alt || src}
        </a>
      ) : null;
    },
    table({ children }) {
      return (
        <div className="my-10 overflow-x-auto">
          <table className="border-collapse text-[0.95em]">{children}</table>
        </div>
      );
    },
    th({ children }) {
      return <th className="border border-border px-8 py-4 text-left font-semibold">{children}</th>;
    },
    td({ children }) {
      return <td className="border border-border px-8 py-4 align-top">{children}</td>;
    },
    input({ checked }) {
      return <input type="checkbox" checked={checked ?? false} readOnly disabled className="mr-6 align-middle" />;
    }
  };
}

const LIVE_COMPONENTS = buildComponents(true);
const DONE_COMPONENTS = buildComponents(false);
const REMARK = [remarkGfm];
const LIVE_REHYPE = [fadeWords];

/** One run of top-level blocks. Rendering is skipped while its text is unchanged, which is what keeps a long streaming reply cheap. */
const Blocks = memo(function Blocks({ text, live }: { text: string; live: boolean }): ReactNode {
  return (
    <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={live ? LIVE_REHYPE : undefined} components={live ? LIVE_COMPONENTS : DONE_COMPONENTS}>
      {tidyMarkdown(text)}
    </ReactMarkdown>
  );
});

interface MarkdownProps {
  text: string;
  variant: 'code' | 'chat';
  /** The text is still streaming: only its last blocks are parsed again as it grows, and new words fade in. */
  live?: boolean;
  className?: string;
}

/**
 * Markdown for assistant replies and user messages; GFM, highlighted code,
 * external links. A long text renders in chunks (see splitBlocks); while it
 * streams only the last one is live. The cuts are the same whether or not the
 * text is streaming, so nothing is rebuilt when a reply finishes.
 */
export const Markdown = memo(function Markdown({ text, variant, live = false, className }: MarkdownProps): ReactNode {
  const chunks = splitBlocks(text);
  return (
    <div className={cn('graft-prose selectable', variant === 'chat' ? 'graft-prose--chat' : 'graft-prose--code', className)}>
      {chunks.map((chunk, i) => {
        const writing = live && i === chunks.length - 1;
        return <Blocks key={i} text={writing ? healMarkdown(chunk) : chunk} live={writing} />;
      })}
    </div>
  );
});
