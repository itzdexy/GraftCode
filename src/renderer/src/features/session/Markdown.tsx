import { memo, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '../../lib/cn';
import { invoke } from '../../lib/ipc';
import { reportError } from '../../stores/toasts';
import { SiteIcon } from '../web/SearchResults';
import { CodeBlock } from './CodeBlock';

function openLink(href: string): void {
  invoke('app:openExternal', { url: href }).catch((error: unknown) => reportError("Couldn't open the link", error));
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

function buildComponents(live: boolean): Components {
  return {
    pre({ node }) {
      const code = node?.children[0];
      const className =
        code && code.type === 'element' && Array.isArray(code.properties.className) ? code.properties.className.map(String) : [];
      const language = className.find((c) => c.startsWith('language-'))?.slice('language-'.length) ?? null;
      return <CodeBlock code={textContent(code).replace(/\n$/, '')} language={language} live={live} />;
    },
    code({ children }) {
      return <code className="rounded-xs border border-code-border bg-code-bg px-4 py-px font-mono text-[0.9em] text-code-fg">{children}</code>;
    },
    a({ href, children }) {
      if (!href) return <span>{children}</span>;
      const text = childText(children);
      if (isCitation(href, text)) {
        return (
          <a
            href={href}
            onClick={(e) => {
              e.preventDefault();
              openLink(href);
            }}
            title={href}
            className="mx-2 inline-flex -translate-y-px items-center gap-4 rounded-full bg-control px-6 py-px align-middle font-sans text-[0.75em] leading-[1.6] text-fg-secondary no-underline transition-ui hover:bg-hover hover:text-fg"
          >
            <SiteIcon url={href} size={11} />
            {text.replace(/^www\./i, '')}
          </a>
        );
      }
      return (
        <a
          href={href}
          onClick={(e) => {
            e.preventDefault();
            openLink(href);
          }}
          className="text-link underline-offset-2 hover:underline"
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

interface MarkdownProps {
  text: string;
  variant: 'code' | 'chat';
  live?: boolean;
  className?: string;
}

/** Markdown for assistant replies and user messages; GFM, highlighted code, external links. */
export const Markdown = memo(function Markdown({ text, variant, live = false, className }: MarkdownProps): ReactNode {
  return (
    <div className={cn('graft-prose selectable', variant === 'chat' ? 'graft-prose--chat' : 'graft-prose--code', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={live ? LIVE_COMPONENTS : DONE_COMPONENTS}>
        {tidyMarkdown(text)}
      </ReactMarkdown>
    </div>
  );
});
