import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { IconButton } from '../../components/Button';
import { highlightLines, type Token } from '../../lib/highlight';
import { logError } from '../../lib/log';
import { reportError } from '../../stores/toasts';

export function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = (text: string): void => {
    navigator.clipboard.writeText(text).then(
      () => setCopied(true),
      (error: unknown) => reportError("Couldn't copy to the clipboard", error)
    );
  };
  return [copied, copy];
}

/** Highlighted lines once available; plain text until then (and while streaming). */
export function useHighlight(code: string, language: string | null, enabled: boolean): Token[][] | null {
  const [result, setResult] = useState<{ code: string; language: string | null; lines: Token[][] | null } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    highlightLines(code, language)
      .then((lines) => {
        if (!cancelled) setResult({ code, language, lines });
      })
      .catch((error: unknown) => logError('Syntax highlighting failed', error));
    return () => {
      cancelled = true;
    };
  }, [code, language, enabled]);
  return enabled && result && result.code === code && result.language === language ? result.lines : null;
}

export function HighlightedLines({ code, lines }: { code: string; lines: Token[][] | null }) {
  if (!lines) return <>{code}</>;
  return (
    <>
      {lines.map((line, i) => (
        <span key={i}>
          {line.map((token, j) => (
            <span key={j} className="code-token" style={token.style}>
              {token.content}
            </span>
          ))}
          {i < lines.length - 1 ? '\n' : null}
        </span>
      ))}
    </>
  );
}

/** Fenced code in messages: language label, copy button, highlighted body that scrolls sideways. */
export function CodeBlock({ code, language, live = false }: { code: string; language: string | null; live?: boolean }) {
  const lines = useHighlight(code, language, !live);
  const [copied, copy] = useCopy();
  return (
    <div className="group/code my-10 overflow-hidden rounded-md border border-border-card bg-code-block">
      <div className="flex h-28 items-center justify-between border-b border-border-card pr-4 pl-10">
        <span className="font-mono text-2xs text-fg-muted">{language ?? 'text'}</span>
        <IconButton label={copied ? 'Copied' : 'Copy code'} size="xs" onClick={() => copy(code)}>
          {copied ? <Check className="size-12 text-success" /> : <Copy className="size-12" />}
        </IconButton>
      </div>
      <pre className="selectable overflow-x-auto px-12 py-10 font-mono text-code leading-[1.5] text-fg">
        <code>
          <HighlightedLines code={code} lines={lines} />
        </code>
      </pre>
    </div>
  );
}
