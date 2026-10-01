import { useEffect, useMemo, useState } from 'react';
import { FileDiff, Globe, SquareTerminal, X } from 'lucide-react';
import type { FileAttachment, ImageBlock, StoredMessage } from '@shared/schemas/messages';
import type { QueuedInput, SessionSummary } from '@shared/schemas/sessions';
import { IconButton } from '../../components/Button';
import { ErrorState, LoadingState } from '../../components/States';
import { invoke } from '../../lib/ipc';
import { useShortcut, useShortcutLabel } from '../../lib/shortcuts';
import { useApp } from '../../stores/app';
import { panelBus, panelsOf, usePanels } from '../../stores/panels';
import { useSessions, viewOf, type SessionView as SessionViewState } from '../../stores/sessions';
import { reportError } from '../../stores/toasts';
import { ChatModelMenu, chatEffortLevels } from '../composer/ChatModelMenu';
import { Composer } from '../composer/Composer';
import { ContextUsage } from '../composer/ContextUsage';
import { EffortPopover } from '../composer/EffortPopover';
import { ModelQuickMenu } from '../composer/ModelQuickMenu';
import { PermissionModeMenu } from '../composer/PermissionModeMenu';
import { effortFor, resolveModel, sameModel } from '../models/modelChoice';
import { PanelColumn } from '../panels/PanelColumn';
import { ViewHeader } from '../shell/ViewHeader';
import { AskUserCard } from './AskUserCard';
import { PermissionCard } from './PermissionCard';
import { useRewind } from './RewindDialog';
import { ChatSessionHeader, CodeSessionHeader } from './SessionHeader';
import { compact, cycleMode, interrupt, sendMessage, setMode, setSessionEffort, setSessionModel, useCommands } from './sessionControls';
import { StatusBar, useDiffStats } from './StatusBar';
import { Transcript } from './Transcript';

export const DISCLAIMER = 'Graft can make mistakes. Review changes before shipping.';

function lastTypedMessage(messages: StoredMessage[]): StoredMessage | null {
  return (
    messages.findLast((m) => m.role === 'user' && (m.meta.kind ?? 'normal') === 'normal' && m.content.some((b) => b.type === 'text' || b.type === 'image')) ?? null
  );
}

function QueueList({ sessionId, queue }: { sessionId: string; queue: QueuedInput[] }) {
  if (queue.length === 0) return null;
  return (
    <ul aria-label="Queued messages" className="flex flex-col gap-4">
      {queue.map((q) => (
        <li key={q.id} className="flex h-28 items-center gap-8 rounded-md border border-dashed border-border pr-4 pl-10 text-base">
          <span className="shrink-0 text-fg-muted">Queued</span>
          <span className="min-w-0 flex-1 truncate text-fg-secondary">
            {q.text}
            {q.attachmentCount > 0 ? ` (+${q.attachmentCount} attachment${q.attachmentCount === 1 ? '' : 's'})` : ''}
          </span>
          <IconButton
            label="Remove from queue"
            size="xs"
            onClick={() => invoke('sessions:removeQueued', { id: sessionId, queueId: q.id }).catch((e: unknown) => reportError("Couldn't remove it", e))}
          >
            <X className="size-14" />
          </IconButton>
        </li>
      ))}
    </ul>
  );
}

function useSessionModel(summary: SessionSummary) {
  const groups = useApp((s) => s.models);
  const loading = useApp((s) => s.modelsLoading);
  return useMemo(() => {
    const exact = summary.model ? groups.flatMap((g) => g.models).find((m) => sameModel(m.ref, summary.model)) ?? null : null;
    const model = exact ?? resolveModel(groups, summary.model);
    const missing = summary.model !== null && exact === null && !loading;
    const blockedReason = model === null ? (loading ? 'Loading models…' : 'No models available from your providers') : null;
    return { model, effort: effortFor(model, summary.effort), missing, blockedReason };
  }, [groups, loading, summary.model, summary.effort]);
}

function PanelToggles({ sessionId, hasFolder }: { sessionId: string; hasFolder: boolean }) {
  const open = usePanels((s) => panelsOf(s, sessionId).open);
  const toggle = usePanels((s) => s.toggle);
  const terminalKey = useShortcutLabel('toggleTerminal');
  const changesKey = useShortcutLabel('toggleChanges');
  if (!hasFolder) return null;
  return (
    <>
      <IconButton label="Terminal" shortcut={terminalKey} active={open.includes('terminal')} aria-pressed={open.includes('terminal')} onClick={() => toggle(sessionId, 'terminal')}>
        <SquareTerminal className="size-16" />
      </IconButton>
      <IconButton label="Changes and files" shortcut={changesKey} active={open.includes('changes')} aria-pressed={open.includes('changes')} onClick={() => toggle(sessionId, 'changes')}>
        <FileDiff className="size-16" />
      </IconButton>
      <IconButton label="Browser" active={open.includes('browser')} aria-pressed={open.includes('browser')} onClick={() => toggle(sessionId, 'browser')}>
        <Globe className="size-16" />
      </IconButton>
    </>
  );
}

/** Opens the Background tasks panel the first time the agent starts a background command. */
function useAutoOpenTasks(sessionId: string): void {
  useEffect(
    () =>
      panelBus.onShellsChanged(sessionId, () => {
        if (panelsOf(usePanels.getState(), sessionId).tasksAutoOpened) return;
        invoke('shells:list', { sessionId })
          .then((shells) => {
            if (!shells.some((s) => s.status === 'running')) return;
            usePanels.getState().markTasksAutoOpened(sessionId);
            usePanels.getState().show(sessionId, 'tasks');
          })
          .catch((error: unknown) => reportError("Couldn't list background commands", error));
      }),
    [sessionId]
  );
}

function CodeSession({ summary, view }: { summary: SessionSummary; view: SessionViewState }) {
  const { model, effort, missing, blockedReason } = useSessionModel(summary);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [statsBump, setStatsBump] = useState(0);
  const stats = useDiffStats(summary.id, `${view.turnActive}:${view.messages.length}:${statsBump}`);
  const commands = useCommands(summary.projectPath, true);
  const lastUser = lastTypedMessage(view.messages);
  const busy = view.turnActive;
  const folder = summary.worktreePath ?? summary.cwd;
  const refreshKey = `${view.turnActive}:${view.messages.length}:${statsBump}`;
  useAutoOpenTasks(summary.id);
  useShortcut('toggleTerminal', () => usePanels.getState().toggle(summary.id, 'terminal'), folder !== null);
  useShortcut('toggleChanges', () => usePanels.getState().toggle(summary.id, 'changes'), folder !== null);
  useShortcut('toggleFiles', () => usePanels.getState().toggleFiles(summary.id), folder !== null);

  const send = (text: string, images: ImageBlock[], files: FileAttachment[]): Promise<boolean> =>
    sendMessage(text, images, files, { summary, lastUserMessageId: lastUser?.id ?? null, openModelMenu: () => setModelMenuOpen(true) });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <CodeSessionHeader
        summary={summary}
        busy={busy}
        onCompact={() => compact(summary.id)}
        onRewind={lastUser ? () => useRewind.getState().open({ sessionId: summary.id, messageId: lastUser.id, chat: false }) : null}
        onShowTasks={() => usePanels.getState().show(summary.id, 'tasks')}
        onToggleFiles={() => usePanels.getState().toggleFiles(summary.id)}
        panels={<PanelToggles sessionId={summary.id} hasFolder={folder !== null} />}
      />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <Transcript
            summary={summary}
            view={view}
            onRewind={busy ? null : (message) => useRewind.getState().open({ sessionId: summary.id, messageId: message.id, chat: false })}
            onEdit={null}
            onRetry={() => invoke('sessions:retry', { id: summary.id }).catch((e: unknown) => reportError("Couldn't retry", e))}
            onRegenerate={null}
          />
          <div className="mx-auto flex w-full max-w-[calc(var(--g-content-width)+48px)] shrink-0 flex-col gap-8 px-24 pb-8">
            {view.question ? <AskUserCard key={view.question.id} sessionId={summary.id} request={view.question} /> : null}
            {view.permission ? <PermissionCard key={view.permission.id} sessionId={summary.id} request={view.permission} /> : null}
            <QueueList sessionId={summary.id} queue={view.queue} />
            <StatusBar summary={summary} stats={stats} onChanged={() => setStatsBump((n) => n + 1)} />
            {missing ? (
              <p role="alert" className="text-sm text-amber-fg">
                This session's model ({summary.model?.modelId}) is no longer available. Pick another one below.
              </p>
            ) : null}
            <Composer
              draftKey={summary.id}
              variant="code"
              placeholder={busy ? 'Queue a message, or press Esc to stop' : 'Type / for commands'}
              supportsImages={model?.supportsVision ?? false}
              busy={busy}
              blockedReason={blockedReason}
              onSubmit={send}
              onInterrupt={() => interrupt(summary.id)}
              onCyclePermission={() => cycleMode(summary)}
              commands={commands}
              mentionRoot={folder}
              autoFocus
              leftControls={<PermissionModeMenu value={summary.permissionMode} onChange={(mode) => setMode(summary, mode)} />}
              rightControls={
                <>
                  <ModelQuickMenu
                    current={model}
                    onSelect={(m) => setSessionModel(summary, m)}
                    open={modelMenuOpen}
                    onOpenChange={setModelMenuOpen}
                    emptyLabel={blockedReason ?? 'No model'}
                  />
                  {model && effort ? <EffortPopover model={model} value={effort} onChange={(level) => setSessionEffort(summary, model, level)} /> : null}
                  <ContextUsage
                    used={summary.usage.contextTokens}
                    limit={summary.usage.contextLimit || model?.contextWindow || 0}
                    session={summary.usage}
                    onCompact={() => compact(summary.id)}
                    compactDisabled={busy || view.messages.length === 0}
                  />
                </>
              }
            />
          </div>
        </div>
        {folder ? <PanelColumn sessionId={summary.id} refreshKey={refreshKey} /> : null}
      </div>
    </div>
  );
}

function ChatSession({ summary, view }: { summary: SessionSummary; view: SessionViewState }) {
  const { model, effort, missing, blockedReason } = useSessionModel(summary);
  const lastUser = lastTypedMessage(view.messages);
  const busy = view.turnActive;
  const levels = chatEffortLevels(model);

  const send = (text: string, images: ImageBlock[], files: FileAttachment[]): Promise<boolean> =>
    sendMessage(text, images, files, { summary, lastUserMessageId: lastUser?.id ?? null, openModelMenu: () => undefined });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ChatSessionHeader summary={summary} />
      <div className="flex min-h-0 flex-1 flex-col">
        <Transcript
          summary={summary}
          view={view}
          onRewind={null}
          onEdit={busy ? null : (message) => useRewind.getState().open({ sessionId: summary.id, messageId: message.id, chat: true })}
          onRetry={() => invoke('sessions:retry', { id: summary.id }).catch((e: unknown) => reportError("Couldn't retry", e))}
          onRegenerate={() => invoke('sessions:regenerate', { id: summary.id }).catch((e: unknown) => reportError("Couldn't retry", e))}
        />
        <div className="mx-auto flex w-full max-w-[calc(var(--g-content-width)+48px)] shrink-0 flex-col gap-8 px-24 pb-8">
          {missing ? (
            <p role="alert" className="text-sm text-amber-fg">
              This chat's model ({summary.model?.modelId}) is no longer available. Pick another one below.
            </p>
          ) : null}
          <Composer
            draftKey={summary.id}
            variant="code"
            placeholder="Write a message…"
            supportsImages={model?.supportsVision ?? false}
            busy={busy}
            blockedReason={blockedReason}
            onSubmit={send}
            onInterrupt={() => interrupt(summary.id)}
            autoFocus
            leftControls={<span className="min-w-0 truncate pl-4 text-sm text-fg-faint">{DISCLAIMER}</span>}
            rightControls={
              <ChatModelMenu
                model={model}
                effort={levels.length > 0 ? effort : null}
                onModel={(m) => setSessionModel(summary, m)}
                onEffort={(level) => {
                  if (model) setSessionEffort(summary, model, level);
                }}
              />
            }
          />
        </div>
      </div>
    </div>
  );
}

/** A chat or code session: transcript, cards and composer. */
export function SessionView({ sessionId }: { sessionId: string }) {
  const summary = useSessions((s) => s.summaries[sessionId]);
  const view = useSessions((s) => viewOf(s, sessionId));

  useEffect(() => {
    void useSessions.getState().open(sessionId);
  }, [sessionId]);

  useShortcut('interrupt', () => interrupt(sessionId), view.turnActive);

  if (!summary) {
    return (
      <div className="flex h-full flex-col">
        <ViewHeader />
        <ErrorState title="Session not found" message="It may have been deleted." />
      </div>
    );
  }
  if (view.error && view.messages.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <ViewHeader />
        <ErrorState title="Couldn't open this session" message={view.error} onRetry={() => void useSessions.getState().open(sessionId)} />
      </div>
    );
  }
  if (view.loading && view.messages.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <ViewHeader />
        <LoadingState label="Opening session…" className="flex-1" />
      </div>
    );
  }
  return summary.kind === 'chat' ? <ChatSession summary={summary} view={view} /> : <CodeSession summary={summary} view={view} />;
}
