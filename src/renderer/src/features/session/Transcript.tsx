import { Fragment, useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, TriangleAlert } from 'lucide-react';
import type { StoredMessage } from '@shared/schemas/messages';
import type { SessionSummary } from '@shared/schemas/sessions';
import { sourceIndex, sourcesOf } from '@shared/sources';
import { Button } from '../../components/Button';
import { Tooltip } from '../../components/Tooltip';
import { cn } from '../../lib/cn';
import { useApp } from '../../stores/app';
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
import { ActivityGroup } from './ActivityGroup';
import { CheckItem, RunningChecks } from './CheckItem';
import { EditsCard } from './EditsCard';
import { FilesCard } from './FilesCard';
import { SourcesContext } from './Markdown';
import { MediaCard } from './MediaCard';
import { useRewind } from './RewindDialog';
import { RunningShell, ShellItem } from './ShellItem';
import { SourcesCard } from './SourcesCard';
import { StatusLine } from './ThinkingIndicator';
import { StepGroup } from './StepGroup';
import { ToolGroup } from './ToolGroup';
import { type TranscriptItem } from './transcriptModel';
import { createTranscriptProjection } from './transcriptProjection';

const STICK_THRESHOLD = 80;

/** Where each session's transcript was left when it wasn't at the bottom, for coming back to it (until the window closes). */
const leftAt = new Map<string, number>();

/**
 * One transcript item. Items that appear while a turn runs (the message just
 * sent, the reply, tool work) rise in; what is already there when a session
 * opens just appears. The choice is made once, when the item mounts.
 */
function Arrival({ live, children }: { live: boolean; children: ReactNode }) {
  const [rise] = useState(live);
  return <div className={rise ? 'motion-rise' : undefined}>{children}</div>;
}

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
  // While a "!" command or the project's checks run no model is working, so the last turn stays as it finished.
  const modelWorking = view.turnActive && view.shellCommand === null && view.checking === null;
  // Chats fold a turn's work into one line; a code session shows it the way Settings → Appearance says.
  const chosen = useApp((s) => s.settings?.appearance.transcriptView ?? 'normal');
  const grouping = variant === 'chat' ? 'summary' : chosen;
  const projectTranscript = useMemo(() => createTranscriptProjection(), []);
  const items = useMemo(
    () => projectTranscript(view.messages, { streaming: view.streaming, running: view.running }, modelWorking, grouping),
    [projectTranscript, view.messages, view.streaming, view.running, modelWorking, grouping]
  );
  const messagesById = useMemo(() => new Map(view.messages.map((m) => [m.id, m])), [view.messages]);
  // What the conversation read and found, for the marks on citations; null when it never used the web.
  const sources = useMemo(() => {
    const seen = sourcesOf(view.messages);
    return seen.length > 0 ? sourceIndex(seen) : null;
  }, [view.messages]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  /** A scroll position waiting to be returned to. */
  const restore = useRef<number | null>(null);
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

  // Opening a session returns to where it was left, or starts at the latest message. Declared before the
  // effect below, so that one already knows which of the two applies when both run for a new session.
  useLayoutEffect(() => {
    const saved = leftAt.get(summary.id);
    restore.current = saved ?? null;
    stick.current = saved === undefined;
    if (saved === undefined) scrollToBottom();
  }, [summary.id, scrollToBottom]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    // Returned to once, as soon as there are messages to scroll (they may still be loading when the session opens).
    if (el && restore.current !== null && items.length > 0) {
      const saved = restore.current;
      restore.current = null;
      if (saved < el.scrollHeight - el.clientHeight - STICK_THRESHOLD) {
        el.scrollTop = saved;
        // No scroll event follows when the position did not change, and the jump-to-latest button depends on one.
        el.dispatchEvent(new Event('scroll'));
        return;
      }
      // What was open above that place has folded since: the place is gone, so start at the latest message as before.
      leftAt.delete(summary.id);
      stick.current = true;
    }
    if (stick.current) scrollToBottom();
  }, [items, scrollToBottom, summary.id]);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD;
    stick.current = bottom;
    setAtBottom(bottom);
    // While a place is still being returned to, scrolling is the transcript settling, not the user leaving it somewhere new.
    if (bottom) leftAt.delete(summary.id);
    else if (restore.current === null) leftAt.set(summary.id, el.scrollTop);
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

  const lastTextKey = items.findLast((i) => i.kind === 'text')?.key ?? null;
  // Undo is offered on the file card of the last turn only. The snapshot it goes back to holds every file as it was
  // before that turn, so after a later turn (which may have changed files by command, leaving no card) it would undo more.
  const lastTurnAt = items.findLastIndex((i) => i.kind === 'user' || i.kind === 'shell' || i.kind === 'mission');
  const lastEdits = items.slice(lastTurnAt + 1).findLast((i) => i.kind === 'edits');
  const undoTurn = (messageId: string | null): void => {
    if (messageId !== null) useRewind.getState().open({ sessionId: summary.id, messageId, chat: false, mode: 'files' });
  };
  const lastItem = items.at(-1);
  // A live block of steps is the working line itself, so it stands in for the one below the transcript.
  const liveSteps = grouping !== 'summary' && lastItem?.kind === 'activity' && lastItem.live;
  const showStatus = modelWorking && view.permission === null && view.question === null && !liveSteps;
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
                incognito: summary.incognito,
                feedback: message.meta.feedback ?? 0,
                onFeedback: (value: -1 | 0 | 1) => sendFeedback(summary.id, message.id, value),
                onRegenerate: isLast && !view.turnActive ? onRegenerate : null
              }
            : null;
        return <AssistantText item={item} variant={variant} actions={actions} />;
      }
      case 'thinking':
        return <ThinkingItem item={item} defaultOpen={grouping === 'verbose'} />;
      case 'tools':
        return <ToolGroup calls={item.calls} />;
      case 'activity':
        return grouping === 'summary' ? (
          <ActivityGroup item={item} />
        ) : (
          <StepGroup
            item={item}
            verbose={grouping === 'verbose'}
            turn={{ sessionId: summary.id, startedAt: view.turnStartedAt, contextTokens: summary.usage.contextTokens, tasks: summary.kind === 'code' }}
          />
        );
      case 'edits':
        return <EditsCard files={item.files} onUndo={item === lastEdits && item.messageId !== null && onRewind ? () => undoTurn(item.messageId) : null} />;
      case 'files':
        return <FilesCard sessionId={summary.id} files={item.files} />;
      case 'sources':
        return <SourcesCard sources={item.sources} />;
      case 'media':
        return <MediaCard sessionId={summary.id} folder={summary.kind === 'code' ? (summary.worktreePath ?? summary.cwd) : null} media={item.media} />;
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
      case 'shell':
        return <ShellItem shell={item.shell} />;
      case 'check':
        return <CheckItem check={item.check} />;
      case 'mission':
        return (
          <p className="flex items-center gap-10 text-sm text-fg-muted">
            <span className="h-px flex-1 bg-divider" aria-hidden="true" />
            {item.afterChecks ? 'The checks failed, so the mission goes on' : 'The mission goes on'}
            {item.turn > 0 ? <span className="text-fg-faint tabular-nums">turn {item.turn} of {item.of}</span> : null}
            <span className="h-px flex-1 bg-divider" aria-hidden="true" />
          </p>
        );
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
          <SourcesContext.Provider value={sources}>
            {items.map((item) => (
              <Arrival key={item.key} live={view.turnActive}>
                {/* Verbose opens rows by default, and a row on screen keeps the state it has: what an item holds is drawn afresh when Verbose goes on or off. */}
                <Fragment key={grouping === 'verbose' ? 'opened' : 'folded'}>{render(item)}</Fragment>
              </Arrival>
            ))}
          </SourcesContext.Provider>
          {view.retrying ? (
            <p className="text-md text-fg-muted">
              {view.retrying.reason}. Retrying in {Math.ceil(view.retrying.delayMs / 1000)}s (attempt {view.retrying.attempt})…
            </p>
          ) : null}
          {view.notices.map((n) => (
            <div key={n.id} className="flex flex-wrap items-center gap-8">
              <p className={cn('text-md', n.level === 'error' ? 'text-danger' : n.level === 'warning' ? 'text-amber-fg' : 'text-fg-muted')}>{n.text}</p>
              {n.action === 'continue' && !view.turnActive ? (
                <Button size="sm" variant="secondary" onClick={onRetry}>
                  Continue
                </Button>
              ) : null}
            </div>
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
          {view.shellCommand !== null ? <RunningShell command={view.shellCommand} startedAt={view.turnStartedAt} /> : null}
          {view.checking ? <RunningChecks commands={view.checking.commands} round={view.checking.round} startedAt={view.checking.startedAt} /> : null}
          {showStatus ? (
            <StatusLine sessionId={summary.id} startedAt={view.turnStartedAt} contextTokens={summary.usage.contextTokens} tasks={summary.kind === 'code'} />
          ) : null}
        </div>
      </div>
      {atBottom ? null : (
        <button
          type="button"
          aria-label="Scroll to the latest message"
          onClick={() => {
            stick.current = true;
            restore.current = null;
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
