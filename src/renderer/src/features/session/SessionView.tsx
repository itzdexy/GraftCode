import { useEffect, useMemo, useState } from 'react';
import { FileDiff, Globe, SquareTerminal, Workflow } from 'lucide-react';
import { commandsFor } from '@shared/commands';
import { currentPlan } from '@shared/plans';
import type { FileAttachment, ImageBlock } from '@shared/schemas/messages';
import { agentRunActive } from '@shared/schemas/agentRuns';
import type { SessionSummary } from '@shared/schemas/sessions';
import { IconButton } from '../../components/Button';
import { ErrorState, LoadingState } from '../../components/States';
import { invoke } from '../../lib/ipc';
import { useShortcut, useShortcutLabel } from '../../lib/shortcuts';
import { useApp } from '../../stores/app';
import { panelBus, panelsOf, usePanels } from '../../stores/panels';
import { usePaneActive, usePanes } from '../../stores/panes';
import { commentsOf, useReview } from '../../stores/review';
import { useSessions, viewOf, type SessionView as SessionViewState } from '../../stores/sessions';
import { reportError } from '../../stores/toasts';
import { ChatModelMenu, chatEffort, chatEffortLevels } from '../composer/ChatModelMenu';
import { Composer } from '../composer/Composer';
import { contextLimit, ContextUsage } from '../composer/ContextUsage';
import { EffortNotice } from '../composer/EffortNotice';
import { EffortPopover } from '../composer/EffortPopover';
import { ModelQuickMenu } from '../composer/ModelQuickMenu';
import { PermissionModeMenu } from '../composer/PermissionModeMenu';
import { TranscriptViewMenu } from '../composer/TranscriptViewMenu';
import { effortFor, resolveModel, sameModel } from '../models/modelChoice';
import { PanelColumn } from '../panels/PanelColumn';
import { ReviewBar } from '../review/ReviewBar';
import { withComments } from '../review/reviewModel';
import { ViewHeader } from '../shell/ViewHeader';
import { AskUserCard } from './AskUserCard';
import { AsideCards } from './AsideCards';
import { MissionBar } from './MissionBar';
import { PermissionCard } from './PermissionCard';
import { PlanBar } from './PlanBar';
import { QueueBar } from './QueueBar';
import { useRewind } from './RewindDialog';
import { ChatSessionHeader, CodeSessionHeader } from './SessionHeader';
import { DetailsColumn, DetailsToggle, useDetailsShown } from './details/SessionDetails';
import { compact, cycleMode, interrupt, lastTypedMessage, sendMessage, setMode, setSessionEffort, setSessionModel, useCommands } from './sessionControls';
import { StatusBar, useDiffStats } from './StatusBar';
import { Transcript } from './Transcript';

export const DISCLAIMER = 'Graft can make mistakes. Review changes before shipping.';

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

function PanelToggles({ sessionId, hasFolder, agentsWorking }: { sessionId: string; hasFolder: boolean; agentsWorking: number }) {
  const open = usePanels((s) => panelsOf(s, sessionId).open);
  const toggle = usePanels((s) => s.toggle);
  const terminalKey = useShortcutLabel('toggleTerminal');
  const changesKey = useShortcutLabel('toggleChanges');
  if (!hasFolder) return <DetailsToggle sessionId={sessionId} />;
  return (
    <>
      <DetailsToggle sessionId={sessionId} />
      <IconButton label="Terminal" shortcut={terminalKey} active={open.includes('terminal')} aria-pressed={open.includes('terminal')} onClick={() => toggle(sessionId, 'terminal')}>
        <SquareTerminal className="size-16" />
      </IconButton>
      <IconButton label="Changes and files" shortcut={changesKey} active={open.includes('changes')} aria-pressed={open.includes('changes')} onClick={() => toggle(sessionId, 'changes')}>
        <FileDiff className="size-16" />
      </IconButton>
      <IconButton label="Browser" active={open.includes('browser')} aria-pressed={open.includes('browser')} onClick={() => toggle(sessionId, 'browser')}>
        <Globe className="size-16" />
      </IconButton>
      <IconButton
        label={agentsWorking > 0 ? `Agents (${String(agentsWorking)} working)` : 'Agents'}
        active={open.includes('agents')}
        aria-pressed={open.includes('agents')}
        onClick={() => toggle(sessionId, 'agents')}
        className="relative"
      >
        <Workflow className="size-16" />
        {agentsWorking > 0 ? <span aria-hidden="true" className="motion-pulse absolute top-3 right-3 size-6 rounded-full bg-blue" /> : null}
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

/** Opens the Agents panel the first time this session runs a group of agents. */
function useAutoOpenAgents(sessionId: string, working: boolean): void {
  useEffect(() => {
    if (!working || panelsOf(usePanels.getState(), sessionId).agentsAutoOpened) return;
    usePanels.getState().markAgentsAutoOpened(sessionId);
    usePanels.getState().show(sessionId, 'agents');
  }, [sessionId, working]);
}

function CodeSession({
  summary,
  view,
  pane,
  onClose,
  atRightEdge,
  atLeftEdge
}: {
  summary: SessionSummary;
  view: SessionViewState;
  pane: 'main' | 'side';
  onClose: (() => void) | null;
  atRightEdge: boolean;
  atLeftEdge: boolean;
}) {
  const focused = usePaneActive(pane);
  const { model, effort, missing, blockedReason } = useSessionModel(summary);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [statsBump, setStatsBump] = useState(0);
  const stats = useDiffStats(summary.id, `${view.turnActive}:${view.messages.length}:${statsBump}`);
  const commands = useCommands(summary.projectPath, true);
  // The plan the session is following: the newest one the user approved, read from the conversation.
  const plan = useMemo(() => currentPlan(view.messages), [view.messages]);
  const lastUser = lastTypedMessage(view.messages);
  const busy = view.turnActive;
  const folder = summary.worktreePath ?? summary.cwd;
  const refreshKey = `${view.turnActive}:${view.messages.length}:${statsBump}`;
  const agentsWorking = view.agentRuns.filter((r) => agentRunActive(r.status)).length;
  const detailsOn = useDetailsShown(summary.id);
  useAutoOpenTasks(summary.id);
  useAutoOpenAgents(summary.id, agentsWorking > 0 && folder !== null);
  useShortcut('toggleTerminal', () => usePanels.getState().toggle(summary.id, 'terminal'), folder !== null && focused);
  useShortcut('toggleChanges', () => usePanels.getState().toggle(summary.id, 'changes'), folder !== null && focused);
  useShortcut('toggleFiles', () => usePanels.getState().toggleFiles(summary.id), folder !== null && focused);

  // The comments that wait on lines of code go with an ordinary message, and are gone once it has. A command leaves them waiting.
  const send = async (text: string, images: ImageBlock[], files: FileAttachment[]): Promise<boolean> => {
    const message = withComments(text, commentsOf(useReview.getState(), summary.id));
    const sent = await sendMessage(message.text, images, files, { summary, lastUserMessageId: lastUser?.id ?? null, openModelMenu: () => setModelMenuOpen(true) });
    if (sent && message.attached) useReview.getState().clear(summary.id);
    return sent;
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <CodeSessionHeader
        summary={summary}
        busy={busy}
        onCompact={() => compact(summary.id)}
        onRewind={lastUser ? () => useRewind.getState().open({ sessionId: summary.id, messageId: lastUser.id, chat: false }) : null}
        onShowTasks={() => usePanels.getState().show(summary.id, 'tasks')}
        onToggleFiles={() => usePanels.getState().toggleFiles(summary.id)}
        panels={<PanelToggles sessionId={summary.id} hasFolder={folder !== null} agentsWorking={agentsWorking} />}
        onClose={onClose}
        atRightEdge={atRightEdge}
        atLeftEdge={atLeftEdge}
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
            onSend={(text) => void send(text, [], []).catch((e: unknown) => reportError("Couldn't send the message", e))}
            pane={pane}
          />
          <div className="transcript-column flex shrink-0 flex-col gap-8 px-24 pb-8">
            {view.question ? <AskUserCard key={view.question.id} sessionId={summary.id} request={view.question} /> : null}
            {view.permission ? <PermissionCard key={view.permission.id} sessionId={summary.id} request={view.permission} /> : null}
            <AsideCards sessionId={summary.id} />
            <QueueBar sessionId={summary.id} queue={view.queue} />
            <MissionBar sessionId={summary.id} mission={view.mission} checking={view.checking !== null} />
            <PlanBar plan={plan} todos={view.todos} />
            <ReviewBar sessionId={summary.id} onSend={() => void send('', [], []).catch((e: unknown) => reportError("Couldn't send the comments", e))} />
            {/* The details column holds the branch and the changes while it is shown. */}
            {detailsOn ? null : <StatusBar summary={summary} stats={stats} onChanged={() => setStatsBump((n) => n + 1)} />}
            {missing ? (
              <p role="alert" className="text-sm text-amber-fg">
                This session's model ({summary.model?.modelId}) is no longer available. Pick another one below.
              </p>
            ) : null}
            <EffortNotice level={effort} />
            <Composer
              draftKey={summary.id}
              variant="code"
              placeholder={busy ? 'Queue a message, or press Esc to stop' : folder ? 'Ask anything · / commands · @ files · ! shell' : 'Type / for commands'}
              supportsImages={model?.supportsVision ?? false}
              busy={busy}
              blockedReason={blockedReason}
              onSubmit={send}
              onInterrupt={() => interrupt(summary.id)}
              onCyclePermission={() => cycleMode(summary)}
              commands={commands}
              mentionRoot={folder}
              shell={folder !== null}
              autoFocus
              leftControls={
                <>
                  <PermissionModeMenu value={summary.permissionMode} onChange={(mode) => setMode(summary, mode)} />
                  <TranscriptViewMenu />
                </>
              }
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
                    limit={contextLimit(summary.usage.contextLimit, model)}
                    session={summary.usage}
                    onCompact={() => compact(summary.id)}
                    loadParts={() => invoke('sessions:context', { id: summary.id })}
                    compactDisabled={busy || view.messages.length === 0}
                  />
                </>
              }
            />
          </div>
        </div>
        {folder ? <PanelColumn sessionId={summary.id} refreshKey={refreshKey} /> : null}
        <DetailsColumn
          summary={summary}
          messages={view.messages}
          runs={view.agentRuns}
          limit={contextLimit(summary.usage.contextLimit, model)}
          stats={stats}
          busy={busy}
          refreshKey={refreshKey}
          shown={detailsOn}
          onCompact={() => compact(summary.id)}
          onStatsChanged={() => setStatsBump((n) => n + 1)}
        />
      </div>
    </div>
  );
}

function ChatSession({
  summary,
  view,
  pane,
  onClose,
  atRightEdge,
  atLeftEdge
}: {
  summary: SessionSummary;
  view: SessionViewState;
  pane: 'main' | 'side';
  onClose: (() => void) | null;
  atRightEdge: boolean;
  atLeftEdge: boolean;
}) {
  const { model, effort, missing, blockedReason } = useSessionModel(summary);
  const lastUser = lastTypedMessage(view.messages);
  const busy = view.turnActive;
  const levels = chatEffortLevels(model);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  // The / menu of a chat: the built-in and the user's own commands, without those that work on a project.
  const listed = useCommands(null, true);
  const commands = useMemo(() => (listed ? commandsFor('chat', listed) : null), [listed]);

  const send = (text: string, images: ImageBlock[], files: FileAttachment[]): Promise<boolean> =>
    sendMessage(text, images, files, { summary, lastUserMessageId: lastUser?.id ?? null, openModelMenu: () => setModelMenuOpen(true) });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ChatSessionHeader summary={summary} onClose={onClose} atRightEdge={atRightEdge} atLeftEdge={atLeftEdge} />
      <div className="flex min-h-0 flex-1 flex-col">
        <Transcript
          summary={summary}
          view={view}
          onRewind={null}
          onEdit={busy ? null : (message) => useRewind.getState().open({ sessionId: summary.id, messageId: message.id, chat: true })}
          onRetry={() => invoke('sessions:retry', { id: summary.id }).catch((e: unknown) => reportError("Couldn't retry", e))}
          onRegenerate={() => invoke('sessions:regenerate', { id: summary.id }).catch((e: unknown) => reportError("Couldn't retry", e))}
          onSend={(text) => void send(text, [], []).catch((e: unknown) => reportError("Couldn't send the message", e))}
          pane={pane}
        />
        <div className="transcript-column flex shrink-0 flex-col gap-8 px-24 pb-8">
          {missing ? (
            <p role="alert" className="text-sm text-amber-fg">
              This chat's model ({summary.model?.modelId}) is no longer available. Pick another one below.
            </p>
          ) : null}
          {view.question ? <AskUserCard key={view.question.id} sessionId={summary.id} request={view.question} /> : null}
          {view.permission ? <PermissionCard key={view.permission.id} sessionId={summary.id} request={view.permission} /> : null}
          <AsideCards sessionId={summary.id} />
          <QueueBar sessionId={summary.id} queue={view.queue} />
          <EffortNotice level={levels.length > 0 ? chatEffort(model, effort) : null} />
          <Composer
            draftKey={summary.id}
            variant="code"
            placeholder="Write a message, or type / for commands"
            supportsImages={model?.supportsVision ?? false}
            busy={busy}
            blockedReason={blockedReason}
            onSubmit={send}
            onInterrupt={() => interrupt(summary.id)}
            commands={commands}
            history={!summary.incognito}
            autoFocus
            leftControls={<span className="min-w-0 truncate pl-4 text-sm text-fg-faint">{DISCLAIMER}</span>}
            rightControls={
              <ChatModelMenu
                model={model}
                effort={levels.length > 0 ? chatEffort(model, effort) : null}
                open={modelMenuOpen}
                onOpenChange={setModelMenuOpen}
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
export function SessionView({ sessionId, pane = 'main', onClose = null }: { sessionId: string; pane?: 'main' | 'side'; onClose?: (() => void) | null }) {
  const summary = useSessions((s) => s.summaries[sessionId]);
  const view = useSessions((s) => viewOf(s, sessionId));
  const focused = usePaneActive(pane);
  // The native window controls sit over the right edge of the window. In a split view that edge belongs
  // to the pane beside the open one, so the open session's own header does not keep clear of them.
  const split = usePanes((s) => s.side !== null);
  const atRightEdge = pane === 'side' || !split;
  const atLeftEdge = pane === 'main';

  useEffect(() => {
    void useSessions.getState().open(sessionId);
  }, [sessionId]);

  useShortcut('interrupt', () => interrupt(sessionId), view.turnActive && focused);

  if (!summary) {
    return (
      <div className="flex h-full flex-col">
        <ViewHeader atRightEdge={atRightEdge} atLeftEdge={atLeftEdge} />
        <ErrorState title="Session not found" message="It may have been deleted." />
      </div>
    );
  }
  if (view.error && view.messages.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <ViewHeader atRightEdge={atRightEdge} atLeftEdge={atLeftEdge} />
        <ErrorState title="Couldn't open this session" message={view.error} onRetry={() => void useSessions.getState().open(sessionId)} />
      </div>
    );
  }
  if (view.loading && view.messages.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <ViewHeader atRightEdge={atRightEdge} atLeftEdge={atLeftEdge} />
        <LoadingState label="Opening session…" className="flex-1" />
      </div>
    );
  }
  return summary.kind === 'chat' ? (
    <ChatSession summary={summary} view={view} pane={pane} onClose={onClose} atRightEdge={atRightEdge} atLeftEdge={atLeftEdge} />
  ) : (
    <CodeSession summary={summary} view={view} pane={pane} onClose={onClose} atRightEdge={atRightEdge} atLeftEdge={atLeftEdge} />
  );
}
