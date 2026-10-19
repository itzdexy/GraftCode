import { useContext, useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronUp, Code2, Copy, Eye, PenTool, SquareTerminal, WrapText } from 'lucide-react';
import { IconButton } from '../../components/Button';
import { Tooltip } from '../../components/Tooltip';
import { cn } from '../../lib/cn';
import { useCodeThemes } from '../../lib/codeThemes';
import { highlightLines, languageForPath, type Token } from '../../lib/highlight';
import { logError } from '../../lib/log';
import { useResolvedPath } from '../../stores/fileRefs';
import { usePanels } from '../../stores/panels';
import { reportError } from '../../stores/toasts';
import { COUNT_FROM, drawRequest, fenceInfo, foldedCode, FOLD_OVER, terminalLine } from './codeBlockModel';
import { ConversationContext } from './conversation';
import { refTooltip } from './fileRefs';
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
  const themes = useCodeThemes();
  const [result, setResult] = useState<{ code: string; language: string | null; lines: Token[][] | null } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    highlightLines(code, language, themes)
      .then((lines) => {
        if (!cancelled) setResult({ code, language, lines });
      })
      .catch((error: unknown) => logError('Syntax highlighting failed', error));
    return () => {
      cancelled = true;
    };
  }, [code, language, enabled, themes]);
  // Lines colored with the themes chosen before stay until the new ones are in, so a change of theme doesn't flash plain text.
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
 * Fenced code in messages. The header names the file the block is for (it
 * opens that file when the project has it) or its language, and from a dozen
 * lines on how many there are. A long block shows its first lines until it is
 * opened; lines wrap on request; a one-line shell command can be typed into
 * the terminal, where the user runs it; a Mermaid block can be sent back to
 * be drawn. An SVG drawing shows as the drawing once it is complete, with a
 * button to see its code instead. Copy always copies all of the code.
 */
export function CodeBlock({ code, language, meta = null, live = false }: { code: string; language: string | null; meta?: string | null; live?: boolean }) {
  const conversation = useContext(ConversationContext);
  const info = useMemo(() => fenceInfo(language, meta), [language, meta]);
  const shownAs = info.language ?? (info.ref ? languageForPath(info.ref.path) : null);
  const lines = useHighlight(code, shownAs, !live);
  const [copied, copy] = useCopy();
  useEffect(() => {
    if (live) lastStreamed = { start: code.slice(0, 80), at: Date.now() };
  }, [live, code]);
  const [arrived] = useState(() => live || (lastStreamed !== null && Date.now() - lastStreamed.at < JUST_WRITTEN_MS && code.startsWith(lastStreamed.start)));
  const [chosen, setChosen] = useState<'drawing' | 'code' | null>(null);
  /** The address that failed to draw: only that drawing falls back to its code. */
  const [broken, setBroken] = useState<string | null>(null);
  const address = live ? null : svgImage(code, info.language ?? (info.ref ? shownAs : null));
  const drawing = address !== null && address !== broken ? address : null;
  const drawn = drawing !== null && (chosen ?? 'drawing') === 'drawing';

  const [wrap, setWrap] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const fold = foldedCode(code, live, expanded);
  // A project's files and its terminal belong to a code session; a chat has neither.
  const sessionId = conversation?.kind === 'code' ? conversation.sessionId : null;
  const file = useResolvedPath(info.ref === null ? null : sessionId, info.ref?.path ?? null);
  // Typed while it streams, a command or a request to draw would be half of one.
  const command = live || sessionId === null ? null : terminalLine(code, info.language);
  const mermaid = !live && conversation?.canDraw === true && info.language?.toLowerCase() === 'mermaid';
  const ref = info.ref;
  const place = ref ? `${ref.path}${ref.line === null ? '' : `:${String(ref.line)}`}` : null;

  return (
    <div className="group/code my-10 overflow-hidden rounded-md border border-border-card bg-code-block">
      <div className="flex h-28 items-center gap-2 border-b border-border-card pr-4 pl-10">
        <div className="flex min-w-0 flex-1 items-baseline gap-8 font-mono text-2xs text-fg-muted">
          {ref && sessionId !== null && file ? (
            <button
              type="button"
              title={refTooltip(file, ref.line)}
              onClick={() => usePanels.getState().openFile(sessionId, file, ref.line === null ? null : { line: ref.line, column: ref.column })}
              className="min-w-0 truncate rounded-xs text-link underline-offset-2 hover:underline"
            >
              {place}
            </button>
          ) : (
            <span className="min-w-0 truncate">{place ?? info.language ?? 'text'}</span>
          )}
          {fold.total >= COUNT_FROM ? <span className="shrink-0 font-sans text-fg-faint tabular-nums">{String(fold.total)} lines</span> : null}
        </div>
        {drawing !== null ? (
          <IconButton label={drawn ? 'Show the code' : 'Show the drawing'} size="xs" onClick={() => setChosen(drawn ? 'code' : 'drawing')}>
            {drawn ? <Code2 className="size-12" /> : <Eye className="size-12" />}
          </IconButton>
        ) : null}
        {mermaid ? (
          <IconButton label="Draw this" size="xs" onClick={() => conversation.send(drawRequest(code))}>
            <PenTool className="size-12" />
          </IconButton>
        ) : null}
        {command !== null && sessionId !== null ? (
          <Tooltip content="Type this into the terminal (you press Enter)">
            <IconButton label="Type into the terminal" tooltip={false} size="xs" onClick={() => usePanels.getState().typeInTerminal(sessionId, command)}>
              <SquareTerminal className="size-12" />
            </IconButton>
          </Tooltip>
        ) : null}
        {drawn ? null : (
          <IconButton label={wrap ? "Don't wrap lines" : 'Wrap lines'} aria-pressed={wrap} active={wrap} size="xs" onClick={() => setWrap(!wrap)}>
            <WrapText className="size-12" />
          </IconButton>
        )}
        <IconButton label={copied ? 'Copied' : 'Copy code'} size="xs" onClick={() => copy(code)}>
          {copied ? <Check className="size-12 text-success" /> : <Copy className="size-12" />}
        </IconButton>
      </div>
      {drawn ? (
        <div className="flex justify-center bg-sunken p-16">
          <img src={drawing} alt="The drawing this code makes" onError={() => setBroken(drawing)} className={cn('max-h-[360px] w-full object-contain', arrived && 'graft-reveal')} />
        </div>
      ) : (
        <>
          <pre
            className={cn(
              'selectable px-12 py-10 font-mono text-code leading-[1.5] text-fg',
              wrap ? 'break-words whitespace-pre-wrap' : 'overflow-x-auto',
              drawing !== null && 'max-h-[420px] overflow-y-auto',
              // The last lines shown fade out: the block goes on below them.
              fold.folded && '[mask-image:linear-gradient(to_bottom,#000_calc(100%_-_44px),transparent)]'
            )}
          >
            <code>
              {fold.folded ? (
                <HighlightedLines code={code.split('\n').slice(0, fold.shown).join('\n')} lines={lines ? lines.slice(0, fold.shown) : null} />
              ) : (
                <HighlightedLines code={code} lines={lines} />
              )}
            </code>
          </pre>
          {!live && fold.total > FOLD_OVER ? (
            <button
              type="button"
              aria-expanded={!fold.folded}
              onClick={() => setExpanded(fold.folded)}
              className="flex h-26 w-full items-center justify-center gap-6 border-t border-border-card text-sm text-fg-muted transition-ui hover:bg-hover hover:text-fg-secondary"
            >
              {fold.folded ? <ChevronDown className="size-12" aria-hidden="true" /> : <ChevronUp className="size-12" aria-hidden="true" />}
              {fold.folded ? `Show all ${String(fold.total)} lines` : 'Show fewer lines'}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
