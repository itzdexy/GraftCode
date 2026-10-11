import { useEffect, useState } from 'react';
import { Check, Code2, Copy, Eye } from 'lucide-react';
import { IconButton } from '../../components/Button';
import { cn } from '../../lib/cn';
import { highlightLines, type Token } from '../../lib/highlight';
import { logError } from '../../lib/log';
import { reportError } from '../../stores/toasts';
import { svgImage } from './svgPreview';

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

/**
 * The code block that streamed last. A reply that finishes is drawn afresh,
 * so the block a drawing appears in is not the one its code streamed into:
 * this is how it knows it has only just been written.
 */
let lastStreamed: { start: string; at: number } | null = null;
const JUST_WRITTEN_MS = 4000;

/**
 * Fenced code in messages: language label, copy button, highlighted body that
 * scrolls sideways. An SVG drawing shows as the drawing once it is complete,
 * with a button to see its code instead.
 */
export function CodeBlock({ code, language, live = false }: { code: string; language: string | null; live?: boolean }) {
  const lines = useHighlight(code, language, !live);
  const [copied, copy] = useCopy();
  useEffect(() => {
    if (live) lastStreamed = { start: code.slice(0, 80), at: Date.now() };
  }, [live, code]);
  const [arrived] = useState(() => live || (lastStreamed !== null && Date.now() - lastStreamed.at < JUST_WRITTEN_MS && code.startsWith(lastStreamed.start)));
  const [chosen, setChosen] = useState<'drawing' | 'code' | null>(null);
  /** The address that failed to draw: only that drawing falls back to its code. */
  const [broken, setBroken] = useState<string | null>(null);
  const address = live ? null : svgImage(code, language);
  const drawing = address !== null && address !== broken ? address : null;
  const drawn = drawing !== null && (chosen ?? 'drawing') === 'drawing';
  return (
    <div className="group/code my-10 overflow-hidden rounded-md border border-border-card bg-code-block">
      <div className="flex h-28 items-center gap-2 border-b border-border-card pr-4 pl-10">
        <span className="flex-1 font-mono text-2xs text-fg-muted">{language ?? 'text'}</span>
        {drawing !== null ? (
          <IconButton label={drawn ? 'Show the code' : 'Show the drawing'} size="xs" onClick={() => setChosen(drawn ? 'code' : 'drawing')}>
            {drawn ? <Code2 className="size-12" /> : <Eye className="size-12" />}
          </IconButton>
        ) : null}
        <IconButton label={copied ? 'Copied' : 'Copy code'} size="xs" onClick={() => copy(code)}>
          {copied ? <Check className="size-12 text-success" /> : <Copy className="size-12" />}
        </IconButton>
      </div>
      {drawn ? (
        <div className="flex justify-center bg-sunken p-16">
          <img src={drawing} alt="The drawing this code makes" onError={() => setBroken(drawing)} className={cn('max-h-[360px] w-full object-contain', arrived && 'graft-reveal')} />
        </div>
      ) : (
        <pre className={cn('selectable overflow-x-auto px-12 py-10 font-mono text-code leading-[1.5] text-fg', drawing !== null && 'max-h-[420px] overflow-y-auto')}>
          <code>
            <HighlightedLines code={code} lines={lines} />
          </code>
        </pre>
      )}
    </div>
  );
}
