import { memo, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '../../lib/cn';
import { invoke } from '../../lib/ipc';
import { reportError } from '../../stores/toasts';
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
        {text}
      </ReactMarkdown>
    </div>
  );
});
