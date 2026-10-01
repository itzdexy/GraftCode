import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronRight, Copy, FileText, Globe, Pencil, RotateCcw, RotateCw, ThumbsDown, ThumbsUp, Volume2, VolumeX } from 'lucide-react';
import type { StoredMessage } from '@shared/schemas/messages';
import { IconButton } from '../../components/Button';
import { Badge } from '../../components/Badge';
import { cn } from '../../lib/cn';
import { invoke } from '../../lib/ipc';
import { reportError } from '../../stores/toasts';
import { imageSrc } from '../composer/attachments';
import { useCopy } from './CodeBlock';
import { Markdown } from './Markdown';
import { TodoList } from './ToolDetail';
import type { TranscriptItem } from './transcriptModel';

type Item<K extends TranscriptItem['kind']> = Extract<TranscriptItem, { kind: K }>;

const COLLAPSE_HEIGHT = 280;

/** Plain text for speech: drops code fences and markdown punctuation. */
export function speakableText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' (code block) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#*_>~|-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

let speakingKey: string | null = null;

function useSpeech(key: string, text: string): [boolean, () => void] {
  const [speaking, setSpeaking] = useState(false);
  useEffect(
    () => () => {
      if (speakingKey === key) {
        window.speechSynthesis.cancel();
        speakingKey = null;
      }
    },
    [key]
  );
  const toggle = (): void => {
    const synth = window.speechSynthesis;
    if (speaking) {
      synth.cancel();
      speakingKey = null;
      setSpeaking(false);
      return;
    }
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(speakableText(text));
    utterance.onend = () => {
      if (speakingKey === key) speakingKey = null;
      setSpeaking(false);
    };
    utterance.onerror = (event) => {
      setSpeaking(false);
      if (event.error !== 'canceled' && event.error !== 'interrupted') reportError("Couldn't read the reply aloud", new Error(event.error));
    };
    speakingKey = key;
    setSpeaking(true);
    synth.speak(utterance);
  };
  return [speaking, toggle];
}

function ActionButton({ label, onClick, children, active = false }: { label: string; onClick: () => void; children: ReactNode; active?: boolean }) {
  return (
    <IconButton label={label} size="xs" onClick={onClick} className={cn('text-icon-muted', active && 'text-icon-strong')} aria-pressed={active}>
      {children}
    </IconButton>
  );
}

/** A typed user turn: raised block in code sessions, right-aligned bubble in chats. */
export function UserMessage({
  item,
  variant,
  onRewind,
  onEdit
}: {
  item: Item<'user'>;
  variant: 'code' | 'chat';
  onRewind: ((message: StoredMessage) => void) | null;
  onEdit: ((message: StoredMessage) => void) | null;
}) {
  const [copied, copy] = useCopy();
  const [expanded, setExpanded] = useState(false);
  const [tall, setTall] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setTall(el.scrollHeight > COLLAPSE_HEIGHT + 24));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const images =
    item.images.length > 0 || item.files.length > 0 ? (
      <div className="mb-6 flex flex-wrap items-center gap-6">
        {item.images.map((image, i) => (
          <img key={i} src={imageSrc(image)} alt={`Attached image ${i + 1}`} className="max-h-[160px] max-w-[240px] rounded-md border border-border object-cover" />
        ))}
        {item.files.map((name, i) => (
          <span key={`${i}-${name}`} className="flex h-28 max-w-[240px] items-center gap-6 rounded-md border border-border bg-surface px-8 text-sm text-fg">
            <FileText className="size-14 shrink-0 text-icon" aria-hidden="true" />
            <span className="truncate">{name}</span>
          </span>
        ))}
      </div>
    ) : null;

  const actions = (
    <div className="flex gap-2 opacity-0 transition-ui group-focus-within/user:opacity-100 group-hover/user:opacity-100">
      <ActionButton label={copied ? 'Copied' : 'Copy'} onClick={() => copy(item.text)}>
        {copied ? <Check className="size-12" /> : <Copy className="size-12" />}
      </ActionButton>
      {onEdit ? (
        <ActionButton label="Edit and resend" onClick={() => onEdit(item.message)}>
          <Pencil className="size-12" />
        </ActionButton>
      ) : null}
      {onRewind ? (
        <ActionButton label="Rewind to here" onClick={() => onRewind(item.message)}>
          <RotateCcw className="size-12" />
        </ActionButton>
      ) : null}
    </div>
  );

  if (variant === 'chat') {
    return (
      <div className="group/user flex flex-col items-end gap-2" data-turn={item.turn}>
        <div className="max-w-[80%] rounded-md bg-raised px-12 py-8 text-md text-fg">
          {images}
          <div className="selectable whitespace-pre-wrap">{item.text}</div>
        </div>
        {actions}
      </div>
    );
  }

  return (
    <div className="group/user flex flex-col gap-2" data-turn={item.turn}>
      <div className="relative rounded-lg bg-raised px-12 py-8">
        <div ref={bodyRef} className={cn('overflow-hidden', !expanded && tall && 'max-h-[280px]')}>
          {images}
          <Markdown text={item.text} variant="code" />
        </div>
        {tall ? (
          <div className="mt-4 flex justify-center">
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              aria-expanded={expanded}
              className="h-20 rounded-full border border-border px-10 text-sm text-fg-muted transition-ui hover:text-fg"
            >
              {expanded ? 'Show less' : 'Show all'}
            </button>
          </div>
        ) : null}
      </div>
      <div className="flex justify-end">{actions}</div>
    </div>
  );
}

interface ReplyActions {
  feedback: -1 | 0 | 1;
  onFeedback: (value: -1 | 0 | 1) => void;
  onRegenerate: (() => void) | null;
}

/** Assistant prose; the last reply of a turn gets copy / read aloud / feedback / retry. */
export function AssistantText({ item, variant, actions }: { item: Item<'text'>; variant: 'code' | 'chat'; actions: ReplyActions | null }) {
  const [copied, copy] = useCopy();
  const [speaking, toggleSpeech] = useSpeech(item.key, item.text);
  return (
    <div className="flex flex-col gap-4">
      <Markdown text={item.text} variant={variant} live={item.live} />
      {actions ? (
        <div className="-ml-4 flex gap-2">
          <ActionButton label={copied ? 'Copied' : 'Copy'} onClick={() => copy(item.text)}>
            {copied ? <Check className="size-12" /> : <Copy className="size-12" />}
          </ActionButton>
          <ActionButton label={speaking ? 'Stop reading' : 'Read aloud'} onClick={toggleSpeech} active={speaking}>
            {speaking ? <VolumeX className="size-12" /> : <Volume2 className="size-12" />}
          </ActionButton>
          <ActionButton label="Good reply" active={actions.feedback === 1} onClick={() => actions.onFeedback(actions.feedback === 1 ? 0 : 1)}>
            <ThumbsUp className="size-12" />
          </ActionButton>
          <ActionButton label="Bad reply" active={actions.feedback === -1} onClick={() => actions.onFeedback(actions.feedback === -1 ? 0 : -1)}>
            <ThumbsDown className="size-12" />
          </ActionButton>
          {actions.onRegenerate ? (
            <ActionButton label="Retry" onClick={actions.onRegenerate}>
              <RotateCw className="size-12" />
            </ActionButton>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ThinkingItem({ item }: { item: Item<'thinking'> }) {
  const [open, setOpen] = useState(false);
  if (item.progress) return <p className="selectable text-md text-fg-muted italic">{item.text}</p>;
  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex min-h-24 items-center gap-6 self-start text-md text-fg-muted transition-ui hover:text-fg-secondary"
      >
        {item.live ? 'Thinking' : 'Thought it through'}
        <ChevronRight className={cn('size-14 transition-transform duration-[var(--g-duration-fast)]', open && 'rotate-90')} aria-hidden="true" />
      </button>
      {open ? <p className="selectable mt-2 border-l border-border pl-10 text-md whitespace-pre-wrap text-fg-muted">{item.text}</p> : null}
    </div>
  );
}

export function TodosItem({ item }: { item: Item<'todos'> }) {
  const [open, setOpen] = useState(false);
  const done = item.todos.filter((t) => t.status === 'completed').length;
  if (!item.latest && !open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex min-h-24 items-center gap-6 self-start text-md text-fg-muted transition-ui hover:text-fg-secondary"
      >
        Updated the task list ({done}/{item.todos.length})
        <ChevronRight className="size-14" aria-hidden="true" />
      </button>
    );
  }
  return (
    <section aria-label="Tasks" className="rounded-md border border-border-card px-12 py-8">
      <p className="mb-6 text-sm text-fg-muted">
        Tasks · {done} of {item.todos.length} done
      </p>
      <TodoList todos={item.todos} />
    </section>
  );
}

export function PlanItem({ item }: { item: Item<'plan'> }) {
  const [open, setOpen] = useState(true);
  const status = item.display ? (item.display.approved ? 'Approved' : 'Changes requested') : 'Waiting for approval';
  return (
    <section aria-label="Plan" className="rounded-md border border-border-card">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex h-32 w-full items-center gap-8 px-12 text-left text-md text-fg-strong"
      >
        <span className="font-medium">Plan</span>
        <Badge tone={item.display?.approved ? 'accent' : item.display ? 'warning' : 'neutral'}>{status}</Badge>
        <ChevronRight className={cn('ml-auto size-14 text-icon-muted transition-transform', open && 'rotate-90')} aria-hidden="true" />
      </button>
      {open ? (
        <div className="border-t border-border-card px-12 py-8">
          <Markdown text={item.plan} variant="code" />
          {item.display?.feedback ? <p className="mt-8 text-sm text-fg-muted">Your feedback: {item.display.feedback}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

export function CompactionItem({ item }: { item: Item<'compaction'> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-6">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex items-center gap-10 text-sm text-fg-muted hover:text-fg-secondary">
        <span className="h-px flex-1 bg-divider" aria-hidden="true" />
        Earlier conversation summarized
        <ChevronRight className={cn('size-12 transition-transform', open && 'rotate-90')} aria-hidden="true" />
        <span className="h-px flex-1 bg-divider" aria-hidden="true" />
      </button>
      {open ? <Markdown text={item.text} variant="code" className="text-fg-secondary" /> : null}
    </div>
  );
}

export function ProviderItem({ item }: { item: Item<'provider'> }) {
  return (
    <p className="flex items-center gap-6 text-md text-fg-muted">
      <Globe className="size-14" aria-hidden="true" />
      {item.summary}
    </p>
  );
}

export function sendFeedback(sessionId: string, messageId: string, value: -1 | 0 | 1): void {
  invoke('sessions:feedback', { sessionId, messageId, value }).catch((error: unknown) => reportError("Couldn't save your feedback", error));
}
