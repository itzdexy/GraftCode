import { Check, Copy, MessageCircleQuestion, RotateCw, X } from 'lucide-react';
import { IconButton } from '../../components/Button';
import { useAsides, type Aside } from '../../stores/asides';
import { useCopy } from './CodeBlock';
import { Markdown } from './Markdown';
import { useSmoothText } from './useSmoothText';

const NONE: Aside[] = [];

/**
 * One side question and its answer. The dashed edge says what the fine print says: this is a note
 * beside the conversation, not a part of it. The answer writes itself in as it arrives, as a reply does.
 */
function AsideCard({ sessionId, aside }: { sessionId: string; aside: Aside }) {
  const asking = aside.status === 'asking';
  const shown = useSmoothText(aside.answer, asking);
  const [copied, copy] = useCopy();
  const dismiss = (): void => useAsides.getState().dismiss(sessionId, aside.id);
  const askAgain = (): void => {
    dismiss();
    useAsides.getState().ask(sessionId, aside.question);
  };
  return (
    <li className="motion-rise motion-sent rounded-lg border border-dashed border-border-strong bg-raised">
      <div className="flex min-h-34 items-start gap-8 py-6 pr-6 pl-9">
        <MessageCircleQuestion className="mt-3 size-14 shrink-0 text-accent" aria-hidden="true" />
        <p className="line-clamp-2 min-w-0 flex-1 pt-1 text-base font-medium text-fg" title={aside.question}>
          {aside.question}
        </p>
        {aside.status === 'failed' ? (
          <IconButton label="Ask again" size="xs" onClick={askAgain}>
            <RotateCw className="size-14" />
          </IconButton>
        ) : null}
        {aside.answer.length > 0 && !asking ? (
          <IconButton label={copied ? 'Copied' : 'Copy the answer'} size="xs" onClick={() => copy(aside.answer)}>
            {copied ? <Check className="size-14" /> : <Copy className="size-14" />}
          </IconButton>
        ) : null}
        <IconButton label={asking ? 'Stop asking' : 'Dismiss'} size="xs" onClick={dismiss}>
          <X className="size-14" />
        </IconButton>
      </div>
      <div aria-live="polite" aria-busy={asking} className="max-h-[min(40vh,320px)] overflow-y-auto pr-9 pb-8 pl-31">
        {shown.text.length > 0 ? <Markdown text={shown.text} variant="code" live={shown.streaming} /> : null}
        {aside.status === 'failed' ? (
          <p role="alert" className="text-sm text-danger">
            {aside.error}
          </p>
        ) : (
          <p className={asking ? 'motion-pulse text-sm text-fg-muted' : 'mt-4 text-sm text-fg-muted'}>
            {asking ? (aside.answer.length > 0 ? 'Answering' : 'Reading the conversation') : 'Kept out of the conversation'}
          </p>
        )}
      </div>
    </li>
  );
}

/**
 * Side questions asked with /btw, above the message box. Each is answered from the conversation as it
 * stands, beside whatever the session is doing, and is never added to it: closing one leaves no trace.
 */
export function AsideCards({ sessionId }: { sessionId: string }) {
  const asides = useAsides((s) => s.bySession[sessionId] ?? NONE);
  if (asides.length === 0) return null;
  return (
    <ul aria-label="Side questions" className="flex flex-col gap-6">
      {asides.map((aside) => (
        <AsideCard key={aside.id} sessionId={sessionId} aside={aside} />
      ))}
    </ul>
  );
}
