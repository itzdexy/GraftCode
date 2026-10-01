import { useEffect, useState } from 'react';
import type { SlashCommand } from '@shared/schemas/app';
import type { EffortLevel, PermissionMode } from '@shared/schemas/common';
import type { FileAttachment, ImageBlock } from '@shared/schemas/messages';
import type { ModelInfo } from '@shared/schemas/models';
import type { SessionSummary } from '@shared/schemas/sessions';
import { invoke } from '../../lib/ipc';
import { logError } from '../../lib/log';
import { reportError } from '../../stores/toasts';
import { useUi } from '../../stores/ui';
import { effortFor } from '../models/modelChoice';
import { useRewind } from './RewindDialog';

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

/**
 * Commands that open app UI instead of going to the agent. Returns true when
 * the text was one of them and has been handled.
 */
export function handleUiCommand(text: string, ctx: UiCommandContext): boolean {
  const match = /^\/([a-z]+)\s*$/i.exec(text.trim());
  if (!match) return false;
  switch (match[1]?.toLowerCase()) {
    case 'resume':
      useUi.getState().setSearchOpen(true);
      return true;
    case 'model':
      ctx.openModelMenu();
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

export async function sendMessage(text: string, images: ImageBlock[], files: FileAttachment[], ctx: UiCommandContext): Promise<boolean> {
  if (images.length === 0 && files.length === 0 && handleUiCommand(text, ctx)) return true;
  await invoke('sessions:send', { id: ctx.summary.id, text, images, files });
  return true;
}
