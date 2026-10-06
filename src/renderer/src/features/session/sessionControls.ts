import { useEffect, useState } from 'react';
import type { SlashCommand } from '@shared/schemas/app';
import type { EffortLevel, PermissionMode } from '@shared/schemas/common';
import type { FileAttachment, ImageBlock, StoredMessage } from '@shared/schemas/messages';
import { missionOpen } from '@shared/schemas/missions';
import type { ModelInfo } from '@shared/schemas/models';
import type { SessionSummary } from '@shared/schemas/sessions';
import { invoke } from '../../lib/ipc';
import { logError } from '../../lib/log';
import { useApp } from '../../stores/app';
import { useSessions, viewOf } from '../../stores/sessions';
import { reportError } from '../../stores/toasts';
import { useUi } from '../../stores/ui';
import { exportSession } from '../shell/sessionActions';
import { openSettings, setMode as setAppMode, startNew } from '../shell/shellActions';
import { effortFor } from '../models/modelChoice';
import { useMissionDialog } from './MissionDialog';
import { useRewind } from './RewindDialog';
import { useSystemPrompt } from './SystemPromptDialog';

/** Slash commands for a project (built-in, user and project commands), refreshed when the folder changes. */
export function useCommands(projectPath: string | null, enabled: boolean): SlashCommand[] | null {
  const [result, setResult] = useState<{ key: string; commands: SlashCommand[] } | null>(null);
  const key = projectPath ?? '';
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    invoke('commands:list', { projectPath })
      .then((commands) => {
        if (!cancelled) setResult({ key, commands });
      })
      .catch((error: unknown) => logError('Could not load slash commands', error));
    return () => {
      cancelled = true;
    };
  }, [projectPath, key, enabled]);
  return enabled && result?.key === key ? result.commands : null;
}

/** The last message the user typed (not a tool result or a command's output): what Rewind and /rewind start from. */
export function lastTypedMessage(messages: StoredMessage[]): StoredMessage | null {
  return (
    messages.findLast((m) => m.role === 'user' && (m.meta.kind ?? 'normal') === 'normal' && m.content.some((b) => b.type === 'text' || b.type === 'image')) ?? null
  );
}

export function setMode(summary: SessionSummary, mode: PermissionMode): void {
  invoke('sessions:setMode', { id: summary.id, mode }).catch((error: unknown) => reportError("Couldn't change the permission mode", error));
}

export function cycleMode(summary: SessionSummary): void {
  invoke('sessions:cycleMode', { id: summary.id }).catch((error: unknown) => reportError("Couldn't change the permission mode", error));
}

export function setSessionModel(summary: SessionSummary, model: ModelInfo): void {
  invoke('sessions:setModel', { id: summary.id, model: model.ref, effort: effortFor(model, summary.effort) }).catch((error: unknown) =>
    reportError("Couldn't switch the model", error)
  );
}

export function setSessionEffort(summary: SessionSummary, model: ModelInfo, effort: EffortLevel): void {
  invoke('sessions:setModel', { id: summary.id, model: model.ref, effort }).catch((error: unknown) => reportError("Couldn't change the effort", error));
}

export function interrupt(sessionId: string): void {
  invoke('sessions:interrupt', { id: sessionId }).catch((error: unknown) => reportError("Couldn't stop the session", error));
}

export function compact(sessionId: string, instructions = ''): void {
  invoke('sessions:compact', { id: sessionId, instructions }).catch((error: unknown) => reportError("Couldn't compact the conversation", error));
}

export interface UiCommandContext {
  summary: SessionSummary;
  lastUserMessageId: string | null;
  openModelMenu: () => void;
}

/** Starts a new session or chat of the same kind. */
function startNewLike(summary: SessionSummary): void {
  const go = (): void => startNew();
  if (useApp.getState().settings?.ui.mode === summary.kind) go();
  else setAppMode(summary.kind).then(go, (error: unknown) => reportError("Couldn't switch modes", error));
}

function commandName(text: string): string | null {
  return /^\/([a-z]+)\s*$/i.exec(text.trim())?.[1]?.toLowerCase() ?? null;
}

/**
 * Commands that open app-wide UI and need no session (they also work on the
 * home screens). Returns true when the text was one of them.
 */
export function handleAppCommand(text: string): boolean {
  switch (commandName(text)) {
    case 'resume':
      useUi.getState().setSearchOpen(true);
      return true;
    case 'config':
      openSettings();
      return true;
    case 'mcp':
      openSettings('mcp');
      return true;
    case 'permissions':
      openSettings('permissions');
      return true;
    default:
      return false;
  }
}

/** Opens the dialog that starts a mission in a code session, with the objective filled in when one was typed. */
export function openMissionDialog(summary: SessionSummary, objective: string): void {
  if (summary.kind !== 'code' || !(summary.worktreePath ?? summary.cwd)) {
    reportError("Can't start a mission here", new Error('Missions run in code sessions that have a project folder.'));
    return;
  }
  const current = viewOf(useSessions.getState(), summary.id).mission;
  if (current && missionOpen(current.status)) {
    reportError('This session already has a mission', new Error('Finish or stop it before starting another.'));
    return;
  }
  useMissionDialog.getState().open({ sessionId: summary.id, projectPath: summary.projectPath, permissionMode: summary.permissionMode, objective });
}

/**
 * Commands that open app UI instead of going to the agent. Returns true when
 * the text was one of them and has been handled.
 */
export function handleUiCommand(text: string, ctx: UiCommandContext): boolean {
  if (handleAppCommand(text)) return true;
  // /mission takes the objective after it; the rest of a mission is filled in the dialog.
  const mission = /^\/mission(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (mission) {
    openMissionDialog(ctx.summary, (mission[1] ?? '').trim());
    return true;
  }
  switch (commandName(text)) {
    case 'model':
      ctx.openModelMenu();
      return true;
    case 'export':
      void exportSession(ctx.summary, 'markdown');
      return true;
    case 'system':
      useSystemPrompt.getState().open(ctx.summary.id);
      return true;
    case 'new':
      startNewLike(ctx.summary);
      return true;
    case 'rewind':
      if (!ctx.lastUserMessageId) {
        reportError('Nothing to rewind', new Error('This session has no messages yet.'));
        return true;
      }
      useRewind.getState().open({ sessionId: ctx.summary.id, messageId: ctx.lastUserMessageId, chat: ctx.summary.kind === 'chat' });
      return true;
    default:
      return false;
  }
}

/** The command in "!command" (code sessions run it in their shell), or null for other text. */
export function shellCommandOf(text: string): string | null {
  const trimmed = text.trim();
  return trimmed.startsWith('!') ? trimmed.slice(1).trim() : null;
}

export async function sendMessage(text: string, images: ImageBlock[], files: FileAttachment[], ctx: UiCommandContext): Promise<boolean> {
  const command = ctx.summary.kind === 'code' && (ctx.summary.worktreePath ?? ctx.summary.cwd) ? shellCommandOf(text) : null;
  if (command !== null) {
    if (command.length === 0) throw new Error('Type a command after the !, for example !git status.');
    if (images.length > 0 || files.length > 0) throw new Error('Attachments can’t go with a shell command. Remove them, or drop the ! to send a message.');
    await invoke('sessions:shell', { id: ctx.summary.id, command });
    return true;
  }
  if (images.length === 0 && files.length === 0 && handleUiCommand(text, ctx)) return true;
  await invoke('sessions:send', { id: ctx.summary.id, text, images, files });
  return true;
}
