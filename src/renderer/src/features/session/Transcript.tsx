import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, TriangleAlert } from 'lucide-react';
import type { StoredMessage } from '@shared/schemas/messages';
import type { SessionSummary } from '@shared/schemas/sessions';
import { Button } from '../../components/Button';
import { Tooltip } from '../../components/Tooltip';
import { cn } from '../../lib/cn';
import type { SessionView } from '../../stores/sessions';
import {
  AssistantText,
  CompactionItem,
  PlanItem,
  ProviderItem,
  sendFeedback,
  ThinkingItem,
  TodosItem,
  UserMessage
} from './MessageItems';
import { ThinkingIndicator } from './ThinkingIndicator';
import { ToolGroup } from './ToolGroup';
import { buildTranscript, type TranscriptItem } from './transcriptModel';

const STICK_THRESHOLD = 80;

interface TranscriptProps {
  summary: SessionSummary;
  view: SessionView;
  onRewind: ((message: StoredMessage) => void) | null;
  onEdit: ((message: StoredMessage) => void) | null;
  onRetry: () => void;
  onRegenerate: (() => void) | null;
  /** Bottom padding so the last message clears overlays. */
  className?: string;
}

function Timeline({ turns, current, onJump }: { turns: Array<{ key: string; text: string }>; current: number; onJump: (index: number) => void }) {
  if (turns.length < 2) return null;
  return (
    <nav aria-label="Turns" className="absolute top-12 left-12 z-[var(--g-z-sticky)] flex max-h-[60%] flex-col overflow-hidden">
      {turns.map((turn, i) => (
        <Tooltip key={turn.key} content={turn.text.slice(0, 120) || 'Message'} side="right">
          <button
            type="button"
            aria-label={`Turn ${i + 1}: ${turn.text.slice(0, 60)}`}
            aria-current={i === current ? 'true' : undefined}
            onClick={() => onJump(i)}
            className="group flex h-[calc(var(--g-timeline-tick-height)+var(--g-timeline-tick-gap))] w-[calc(var(--g-timeline-tick-width)+8px)] items-center"
          >
            <span
              className={cn(
                'block h-[var(--g-timeline-tick-height)] w-[var(--g-timeline-tick-width)] rounded-full transition-ui group-hover:bg-tick-current',
                i === current ? 'bg-tick-current' : 'bg-tick'
              )}
            />
          </button>
        </Tooltip>
      ))}
    </nav>
  );
}

/** Scrollable transcript with sticky autoscroll, a jump-to-bottom button and a turn timeline. */
export function Transcript({ summary, view, onRewind, onEdit, onRetry, onRegenerate, className }: TranscriptProps) {
  const variant = summary.kind === 'chat' ? 'chat' : 'code';
  const items = useMemo(() => buildTranscript(view.messages, { streaming: view.streaming, running: view.running }), [view.messages, view.streaming, view.running]);
  const messagesById = useMemo(() => new Map(view.messages.map((m) => [m.id, m])), [view.messages]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [currentTurn, setCurrentTurn] = useState(0);

  const turns = useMemo(
    () => items.filter((i): i is Extract<TranscriptItem, { kind: 'user' }> => i.kind === 'user').map((i) => ({ key: i.key, text: i.text })),
    [items]
  );

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  // Follow new content while pinned to the bottom (content can also grow as code highlights or images load).
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const observer = new ResizeObserver(() => {
      if (stick.current) scrollToBottom();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [scrollToBottom]);

  useLayoutEffect(() => {
    if (stick.current) scrollToBottom();
  }, [items, scrollToBottom]);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD;
    stick.current = bottom;
    setAtBottom(bottom);
    const markers = el.querySelectorAll<HTMLElement>('[data-turn]');
    let current = 0;
    markers.forEach((marker, i) => {
      if (marker.offsetTop - el.scrollTop <= el.clientHeight / 3) current = i;
    });
    setCurrentTurn(current);
  };

  const jumpTo = (index: number): void => {
    const el = scrollRef.current;
    const marker = el?.querySelectorAll<HTMLElement>('[data-turn]')[index];
    if (!el || !marker) return;
    stick.current = false;
    el.scrollTo({ top: marker.offsetTop - 16, behavior: 'smooth' });
  };

  useEffect(() => {
    // Opening a session starts at the latest message.
    stick.current = true;
    scrollToBottom();
  }, [summary.id, scrollToBottom]);

  const runningCall = Object.values(view.running)[0] ?? null;
  const lastTextKey = items.findLast((i) => i.kind === 'text')?.key ?? null;
  const showIndicator = view.turnActive && !view.streaming?.text && view.permission === null && view.question === null;
  const lastItem = items.at(-1);
  const failed = summary.status === 'error' && summary.lastError && !view.turnActive;

  const render = (item: TranscriptItem): JSX.Element | null => {
    switch (item.kind) {
      case 'user':
        return <UserMessage item={item} variant={variant} onRewind={onRewind} onEdit={onEdit} />;
      case 'text': {
        const message = messagesById.get(item.messageId);
        const isLast = item.key === lastTextKey;
        const actions =
          item.endOfTurn && variant === 'chat' && message
            ? {
                feedback: message.meta.feedback ?? 0,
                onFeedback: (value: -1 | 0 | 1) => sendFeedback(summary.id, message.id, value),
                onRegenerate: isLast && !view.turnActive ? onRegenerate : null
              }
            : null;
        return <AssistantText item={item} variant={variant} actions={actions} />;
      }
      case 'thinking':
        return <ThinkingItem item={item} />;
      case 'tools':
        return <ToolGroup calls={item.calls} />;
      case 'todos':
        return <TodosItem item={item} />;
      case 'plan':
        return <PlanItem item={item} />;
      case 'provider':
        return <ProviderItem item={item} />;
      case 'compaction':
        return <CompactionItem item={item} />;
      case 'command-output':
        return <pre className="selectable rounded-md bg-sunken px-12 py-8 font-mono text-[calc(var(--g-code-font-size)-1px)] whitespace-pre-wrap text-fg-secondary">{item.text}</pre>;
      case 'notice':
        return <p className="text-md text-fg-muted">{item.text}</p>;
      case 'error':
        return (
          <div role="alert" className="flex items-start gap-8 text-md">
            <TriangleAlert className="mt-2 size-14 shrink-0 text-danger" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="selectable break-words text-danger">{item.message}</p>
              {item === lastItem && !view.turnActive ? (
                <Button size="sm" className="mt-6" onClick={onRetry}>
                  Retry
                </Button>
              ) : null}
            </div>
          </div>
        );
      case 'interrupted':
        return <p className="text-md text-fg-muted">Stopped.</p>;
    }
  };

  return (
    <div className="relative min-h-0 flex-1">
      {variant === 'code' ? <Timeline turns={turns} current={currentTurn} onJump={jumpTo} /> : null}
      <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto" aria-label="Conversation" role="log" aria-live="off">
        <div ref={contentRef} className={cn('mx-auto flex w-full max-w-[calc(var(--g-content-width)+48px)] flex-col gap-14 px-24 pt-16 pb-24', className)}>
          {items.map((item) => (
            <div key={item.key}>{render(item)}</div>
          ))}
          {view.retrying ? (
            <p className="text-md text-fg-muted">
              {view.retrying.reason}. Retrying in {Math.ceil(view.retrying.delayMs / 1000)}s (attempt {view.retrying.attempt})…
            </p>
          ) : null}
          {view.notices.map((n) => (
            <p key={n.id} className={cn('text-md', n.level === 'error' ? 'text-danger' : n.level === 'warning' ? 'text-amber-fg' : 'text-fg-muted')}>
              {n.text}
            </p>
          ))}
          {failed && lastItem?.kind !== 'error' ? (
            <div role="alert" className="flex items-start gap-8 text-md">
              <TriangleAlert className="mt-2 size-14 shrink-0 text-danger" aria-hidden="true" />
              <div>
                <p className="selectable text-danger">{summary.lastError?.message}</p>
                <Button size="sm" className="mt-6" onClick={onRetry}>
                  Retry
                </Button>
              </div>
            </div>
          ) : null}
          {showIndicator ? <ThinkingIndicator startedAt={view.turnStartedAt} detail={runningCall?.summary ?? null} /> : null}
        </div>
      </div>
      {atBottom ? null : (
        <button
          type="button"
          aria-label="Scroll to the latest message"
          onClick={() => {
            stick.current = true;
            scrollToBottom('smooth');
          }}
          className="absolute bottom-12 left-1/2 flex size-28 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-surface text-icon shadow-popover transition-ui hover:text-icon-strong"
        >
          <ArrowDown className="size-14" />
        </button>
      )}
    </div>
  );
}
