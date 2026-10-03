import type { ComponentType } from 'react';
import {
  Archive,
  Calendar,
  Code,
  Copy,
  EyeOff,
  FileDown,
  FileText,
  FolderOpen,
  Globe,
  History,
  Info,
  Keyboard,
  Layers,
  ListChecks,
  MessagesSquare,
  Monitor,
  Moon,
  Palette,
  PanelLeft,
  Pin,
  RefreshCw,
  Search,
  Shrink,
  Square,
  Sun,
  Terminal,
  Files,
  GitCompare,
  Wrench,
  Zap
} from 'lucide-react';
import type { AppSettings, AppSettingsPatch, ShortcutId } from '@shared/schemas/appSettings';
import { INTEGRATIONS } from '@shared/integrations';
import type { SessionSummary } from '@shared/schemas/sessions';
import { invoke } from '../../lib/ipc';
import { useApp } from '../../stores/app';
import { useNav, type Route } from '../../stores/nav';
import { usePanels } from '../../stores/panels';
import { reportError, useToasts } from '../../stores/toasts';
import { useUi } from '../../stores/ui';
import { useRewind } from '../session/RewindDialog';
import { compact, interrupt } from '../session/sessionControls';
import { useSystemPrompt } from '../session/SystemPromptDialog';
import { ACCENTS, PALETTES, SETTINGS_SECTIONS } from '../settings/sections';
import { duplicateSession, exportSession, setPinned } from './sessionActions';
import { useSessionDialog } from './SessionDialogs';
import { openSettings, setMode, startNew, toggleSidebar } from './shellActions';

export interface PaletteCommand {
  id: string;
  title: string;
  group: string;
  /** Extra words the search matches (not shown). */
  keywords?: string;
  shortcut?: ShortcutId;
  icon?: ComponentType<{ className?: string }>;
  /** The current choice among options such as themes. */
  checked?: boolean;
  run: () => void | Promise<void>;
}

export interface PaletteContext {
  route: Route;
  session: SessionSummary | null;
  turnActive: boolean;
  lastUserMessageId: string | null;
  settings: AppSettings | null;
}

function save(patch: AppSettingsPatch): Promise<void> {
  return useApp
    .getState()
    .updateSettings(patch)
    .then(
      () => undefined,
      (error: unknown) => reportError("Couldn't save the setting", error)
    );
}

async function startIn(mode: 'chat' | 'code', incognito = false): Promise<void> {
  useUi.getState().setIncognito(incognito);
  await setMode(mode);
  startNew();
}

function sessionCommands(session: SessionSummary, ctx: PaletteContext): PaletteCommand[] {
  const group = session.kind === 'code' ? 'This session' : 'This chat';
  const folder = session.worktreePath ?? session.cwd;
  const out: PaletteCommand[] = [];
  if (ctx.turnActive) out.push({ id: 'session.stop', title: 'Stop the running turn', group, icon: Square, shortcut: 'interrupt', run: () => interrupt(session.id) });
  if (!ctx.turnActive) out.push({ id: 'session.compact', title: 'Compact conversation', group, keywords: 'summarize context free', icon: Shrink, run: () => compact(session.id) });
  if (!ctx.turnActive && ctx.lastUserMessageId) {
    const messageId = ctx.lastUserMessageId;
    out.push({ id: 'session.rewind', title: 'Rewind…', group, keywords: 'undo restore checkpoint', icon: History, run: () => useRewind.getState().open({ sessionId: session.id, messageId, chat: session.kind === 'chat' }) });
  }
  out.push({ id: 'session.system', title: 'View system prompt', group, keywords: 'instructions prompt tools developer', icon: FileText, run: () => useSystemPrompt.getState().open(session.id) });
  out.push({ id: 'session.export.md', title: 'Export as Markdown…', group, keywords: 'save share', icon: FileDown, run: () => exportSession(session, 'markdown') });
  out.push({ id: 'session.export.json', title: 'Export as JSON…', group, keywords: 'save', icon: FileDown, run: () => exportSession(session, 'json') });
  if (!session.incognito) {
    out.push({ id: 'session.duplicate', title: 'Duplicate', group, keywords: 'copy fork', icon: Copy, run: () => duplicateSession(session) });
    out.push({ id: 'session.pin', title: session.pinned ? 'Unpin' : 'Pin', group, icon: Pin, run: () => setPinned(session, !session.pinned) });
    if (!session.archived) out.push({ id: 'session.archive', title: 'Archive…', group, icon: Archive, run: () => useSessionDialog.getState().open('archive', session) });
  }
  if (session.kind === 'code' && folder) {
    const panels = usePanels.getState();
    out.push(
      { id: 'panel.terminal', title: 'Toggle terminal', group, icon: Terminal, shortcut: 'toggleTerminal', run: () => panels.toggle(session.id, 'terminal') },
      { id: 'panel.changes', title: 'Toggle changes', group, keywords: 'diff git', icon: GitCompare, shortcut: 'toggleChanges', run: () => panels.toggle(session.id, 'changes') },
      { id: 'panel.files', title: 'Toggle files', group, keywords: 'explorer tree', icon: Files, shortcut: 'toggleFiles', run: () => panels.toggleFiles(session.id) },
      { id: 'panel.browser', title: 'Toggle browser', group, keywords: 'preview localhost web', icon: Globe, run: () => panels.toggle(session.id, 'browser') },
      { id: 'panel.tasks', title: 'Background tasks', group, keywords: 'shells processes', icon: ListChecks, run: () => panels.toggle(session.id, 'tasks') },
      {
        id: 'session.editor',
        title: 'Open folder in editor',
        group,
        keywords: 'vscode code',
        icon: FolderOpen,
        run: () => invoke('app:openInEditor', { path: folder }).then(() => undefined, (e: unknown) => reportError("Couldn't open the folder", e))
      }
    );
  }
  return out;
}

/** Everything the command palette offers right now, in display order. */
export function paletteCommands(ctx: PaletteContext): PaletteCommand[] {
  const appearance = ctx.settings?.appearance;
  const mode = ctx.settings?.ui.mode ?? 'code';
  const commands: PaletteCommand[] = [
    { id: 'new.code', title: 'New code session', group: 'Start', keywords: 'project agent', icon: Code, shortcut: mode === 'code' ? 'newSession' : undefined, run: () => startIn('code') },
    { id: 'new.chat', title: 'New chat', group: 'Start', keywords: 'conversation', icon: MessagesSquare, shortcut: mode === 'chat' ? 'newSession' : undefined, run: () => startIn('chat') },
    { id: 'new.incognito', title: 'New incognito chat', group: 'Start', keywords: 'private temporary', icon: EyeOff, run: () => startIn('chat', true) },
    { id: 'go.search', title: 'Search chats and sessions', group: 'Start', keywords: 'find resume history', icon: Search, shortcut: 'search', run: () => useUi.getState().setSearchOpen(true) },
    ...(ctx.session ? sessionCommands(ctx.session, ctx) : []),
    { id: 'go.projects', title: 'Projects', group: 'Go to', keywords: 'folders repositories', icon: Layers, run: () => useNav.getState().go({ name: 'projects' }) },
    { id: 'go.scheduled', title: 'Scheduled tasks', group: 'Go to', keywords: 'cron automation recurring', icon: Calendar, run: () => useNav.getState().go({ name: 'scheduled' }) },
    { id: 'go.artifacts', title: 'Artifacts', group: 'Go to', keywords: 'files outputs', icon: Zap, run: () => useNav.getState().go({ name: 'artifacts' }) },
    { id: 'go.customize', title: 'Customize: commands, skills, hooks and MCP', group: 'Go to', keywords: 'agents plugins', icon: Wrench, run: () => useNav.getState().go({ name: 'customize' }) },
    { id: 'view.sidebar', title: 'Show or hide the sidebar', group: 'View', icon: PanelLeft, shortcut: 'toggleSidebar', run: () => toggleSidebar() },
    mode === 'code'
      ? { id: 'view.mode', title: 'Switch to Chat', group: 'View', keywords: 'mode', icon: MessagesSquare, run: () => setMode('chat') }
      : { id: 'view.mode', title: 'Switch to Code', group: 'View', keywords: 'mode', icon: Code, run: () => setMode('code') }
  ];

  if (appearance) {
    const themes = [
      { id: 'system', title: 'System', icon: Monitor },
      { id: 'dark', title: 'Dark', icon: Moon },
      { id: 'light', title: 'Light', icon: Sun }
    ] as const;
    for (const t of themes) {
      commands.push({ id: `theme.${t.id}`, title: `Theme: ${t.title}`, group: 'Appearance', keywords: 'mode color', icon: t.icon, checked: appearance.theme === t.id, run: () => save({ appearance: { theme: t.id } }) });
    }
    for (const p of PALETTES) {
      commands.push({ id: `palette.${p.id}`, title: `Palette: ${p.label}`, group: 'Appearance', keywords: `colors theme ${p.description}`, icon: Palette, checked: appearance.palette === p.id, run: () => save({ appearance: { palette: p.id } }) });
    }
    for (const a of ACCENTS) {
      commands.push({ id: `accent.${a.id}`, title: `Accent: ${a.label}`, group: 'Appearance', keywords: 'color highlight', icon: Palette, checked: appearance.accent === a.id, run: () => save({ appearance: { accent: a.id } }) });
    }
    commands.push({
      id: 'appearance.motion',
      title: appearance.reducedMotion ? 'Turn animations back on' : 'Reduce motion',
      group: 'Appearance',
      keywords: 'animations accessibility',
      run: () => save({ appearance: { reducedMotion: !appearance.reducedMotion } })
    });
  }

  for (const section of SETTINGS_SECTIONS) {
    // The integrations page answers to the apps it connects, so "blender" or "unity" finds it.
    const keywords = section.id === 'mcp' ? `${section.description} ${INTEGRATIONS.map((i) => i.name).join(' ')}` : section.description;
    commands.push({ id: `settings.${section.id}`, title: `Settings: ${section.label}`, group: 'Settings', keywords, icon: section.icon, shortcut: section.id === 'profile' ? 'openSettings' : undefined, run: () => openSettings(section.id) });
  }

  commands.push(
    { id: 'help.shortcuts', title: 'Keyboard shortcuts', group: 'Help', keywords: 'keys hotkeys', icon: Keyboard, run: () => useUi.getState().setDialog('shortcuts') },
    { id: 'help.about', title: 'About Graft', group: 'Help', keywords: 'version', icon: Info, run: () => useUi.getState().setDialog('about') },
    {
      id: 'help.updates',
      title: 'Check for updates',
      group: 'Help',
      keywords: 'upgrade version download',
      icon: RefreshCw,
      run: () =>
        invoke('updates:check').then(
          (state) => {
            useApp.getState().setUpdate(state);
            if (state.status === 'none') useToasts.getState().push({ tone: 'success', title: 'Graft is up to date' });
            else if (state.status === 'error') reportError("Couldn't check for updates", new Error(state.message ?? 'unknown error'));
            else if (state.status === 'unsupported' || state.status === 'off') openSettings('about');
          },
          (e: unknown) => reportError("Couldn't check for updates", e)
        )
    }
  );
  return commands;
}
