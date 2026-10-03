import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Box, ChevronDown, Clipboard, Coffee, EllipsisVertical, FileDown, Files, FileText, FolderOpen, History, Laptop, ListChecks, Settings2, Shrink } from 'lucide-react';
import type { SessionSummary } from '@shared/schemas/sessions';
import { Badge } from '../../components/Badge';
import { IconButton } from '../../components/Button';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuSwitchItem, MenuTrigger } from '../../components/Menu';
import { cn } from '../../lib/cn';
import { invoke } from '../../lib/ipc';
import { setProjectSandbox } from '../../lib/sandbox';
import { useShortcutLabel } from '../../lib/shortcuts';
import { useApp } from '../../stores/app';
import { useNav } from '../../stores/nav';
import { usePower } from '../../stores/power';
import { reportError, useToasts } from '../../stores/toasts';
import { IncognitoBadge } from '../privacy/IncognitoBadge';
import { exportSession, renameSession } from '../shell/sessionActions';
import { SessionMenuItems } from '../shell/SessionMenu';
import { ViewHeader } from '../shell/ViewHeader';
import { useSystemPrompt } from './SystemPromptDialog';

/** Title with a dropdown of session actions; Rename edits in place. */
export function TitleMenu({ summary, size = 'md' }: { summary: SessionSummary; size?: 'md' | 'lg' }) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(summary.title);
  const inputRef = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const renameRequested = useRef(false);

  useEffect(() => {
    if (!renaming) return;
    done.current = false;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [renaming]);

  const commit = (): void => {
    if (done.current) return;
    done.current = true;
    setRenaming(false);
    if (draft.trim() && draft.trim() !== summary.title) void renameSession(summary.id, draft);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      done.current = true;
      setRenaming(false);
    }
  };

  const text = size === 'lg' ? 'text-md' : 'text-base';
  if (renaming) {
    return (
      <input
        ref={inputRef}
        value={draft}
        maxLength={200}
        aria-label="Session title"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={commit}
        className={`h-24 w-[min(360px,40vw)] rounded-sm border border-border-strong bg-input px-6 font-medium text-fg outline-none ${text}`}
      />
    );
  }
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          className={`inline-flex h-24 min-w-0 items-center gap-6 rounded-sm px-6 font-medium text-fg-strong transition-ui hover:bg-hover data-[state=open]:bg-hover ${text}`}
        >
          <span className="truncate">{summary.title}</span>
          <ChevronDown className="size-14 shrink-0 text-icon" aria-hidden="true" />
        </button>
      </MenuTrigger>
      <MenuContent
        align="start"
        className="min-w-[200px]"
        onCloseAutoFocus={(e) => {
          if (renameRequested.current) {
            renameRequested.current = false;
            e.preventDefault();
          }
        }}
      >
        <SessionMenuItems
          session={summary}
          onRename={() => {
            renameRequested.current = true;
            setDraft(summary.title);
            setRenaming(true);
          }}
        />
      </MenuContent>
    </Menu>
  );
}

/** Where the session's commands run: this computer, or the project's sandbox. Clicking switches it. */
function EnvironmentMenu({ summary }: { summary: SessionSummary }) {
  const project = useApp((s) => s.projects.find((p) => p.id === summary.projectId) ?? null);
  const sandboxed = project?.settings.sandbox === true;
  const where = sandboxed ? 'Commands run in a sandbox' : 'Commands run on this computer';
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={where}
          title={where}
          className="inline-flex size-24 shrink-0 items-center justify-center rounded-sm transition-ui hover:bg-hover data-[state=open]:bg-hover"
        >
          {sandboxed ? <Box className="size-16 text-accent" aria-hidden="true" /> : <Laptop className="size-16 text-icon" aria-hidden="true" />}
        </button>
      </MenuTrigger>
      <MenuContent align="start" className="min-w-[260px]">
        <MenuSwitchItem
          icon={<Box className={cn('size-14', sandboxed && 'text-accent')} />}
          checked={sandboxed}
          disabled={!project}
          onCheckedChange={(on) => {
            if (project) setProjectSandbox(project, on).catch((e: unknown) => reportError("Couldn't change the sandbox", e));
          }}
          description={project ? 'For this project, from the next message' : 'Needs a project folder'}
        >
          Run commands in a sandbox
        </MenuSwitchItem>
        <MenuSeparator />
        <MenuItem icon={<Settings2 className="size-14" />} onSelect={() => useNav.getState().go({ name: 'settings', section: 'sandbox' })}>
          Sandbox settings…
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

function copyText(text: string, what: string): void {
  navigator.clipboard.writeText(text).then(
    () => useToasts.getState().push({ tone: 'success', title: `${what} copied` }),
    (error: unknown) => reportError("Couldn't copy to the clipboard", error)
  );
}

interface CodeHeaderProps {
  summary: SessionSummary;
  onCompact: () => void;
  onRewind: (() => void) | null;
  onShowTasks: () => void;
  onToggleFiles: () => void;
  busy: boolean;
  /** Panel toggles (terminal, changes, browser) placed before the menu. */
  panels?: ReactNode;
}

/** Code session header in the titlebar row: environment, title menu, project chip, panels and more. */
export function CodeSessionHeader({ summary, onCompact, onRewind, onShowTasks, onToggleFiles, busy, panels }: CodeHeaderProps) {
  const folder = summary.worktreePath ?? summary.cwd;
  const filesLabel = useShortcutLabel('toggleFiles');
  const keepAwake = usePower((s) => s.keepAwake?.includes(summary.id) ?? false);
  useEffect(() => usePower.getState().load(), []);
  return (
    <ViewHeader
      actions={
        <>
          {panels}
          <Menu>
            <MenuTrigger asChild>
              <IconButton label="More actions">
                <EllipsisVertical className="size-16" />
              </IconButton>
            </MenuTrigger>
            <MenuContent align="end" className="min-w-[230px]">
              <MenuItem icon={<Shrink className="size-14" />} disabled={busy} onSelect={onCompact}>
                Compact conversation
              </MenuItem>
              {onRewind ? (
                <MenuItem icon={<History className="size-14" />} disabled={busy} onSelect={onRewind}>
                  Rewind…
                </MenuItem>
              ) : null}
              {folder ? (
                <MenuItem icon={<Files className="size-14" />} shortcut={filesLabel} onSelect={onToggleFiles}>
                  Files
                </MenuItem>
              ) : null}
              {folder ? (
                <MenuItem icon={<ListChecks className="size-14" />} onSelect={onShowTasks}>
                  Background tasks
                </MenuItem>
              ) : null}
              <MenuSwitchItem
                icon={<Coffee className="size-14" />}
                checked={keepAwake}
                onCheckedChange={(on) => usePower.getState().setKeepAwake(summary.id, on)}
                description="Only for this session, while it works"
              >
                Keep computer awake
              </MenuSwitchItem>
              <MenuSeparator />
              {folder ? (
                <MenuItem
                  icon={<FolderOpen className="size-14" />}
                  onSelect={() => {
                    invoke('app:openInEditor', { path: folder }).catch((e: unknown) => reportError("Couldn't open the folder", e));
                  }}
                >
                  Open folder in editor
                </MenuItem>
              ) : null}
              {folder ? (
                <MenuItem icon={<Clipboard className="size-14" />} onSelect={() => copyText(folder, 'Folder path')}>
                  Copy folder path
                </MenuItem>
              ) : null}
              <MenuItem icon={<FileDown className="size-14" />} onSelect={() => void exportSession(summary, 'markdown')}>
                Export as Markdown…
              </MenuItem>
              <MenuItem icon={<FileText className="size-14" />} onSelect={() => useSystemPrompt.getState().open(summary.id)}>
                View system prompt
              </MenuItem>
            </MenuContent>
          </Menu>
        </>
      }
    >
      <EnvironmentMenu summary={summary} />
      <TitleMenu summary={summary} />
      {summary.projectName ? (
        <Badge className="h-20 max-w-[200px] truncate bg-control px-6 text-xs text-fg-secondary">
          {summary.projectName}
          {summary.worktreePath && summary.branch ? <span className="text-fg-muted"> · {summary.branch}</span> : null}
        </Badge>
      ) : null}
    </ViewHeader>
  );
}

/** Chat header: drag strip, then the title row with export. */
export function ChatSessionHeader({ summary }: { summary: SessionSummary }) {
  return (
    <>
      <ViewHeader />
      <div className="flex h-36 shrink-0 items-center gap-8 pr-16 pl-12">
        <TitleMenu summary={summary} size="lg" />
        {summary.incognito ? <IncognitoBadge providerId={summary.model?.providerId ?? null} /> : null}
        <div className="flex-1" />
        <Menu>
          <MenuTrigger asChild>
            <IconButton label="Export chat">
              <FileDown className="size-16" />
            </IconButton>
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem onSelect={() => void exportSession(summary, 'markdown')}>Export as Markdown…</MenuItem>
            <MenuItem onSelect={() => void exportSession(summary, 'json')}>Export as JSON…</MenuItem>
            <MenuSeparator />
            <MenuItem icon={<FileText className="size-14" />} onSelect={() => useSystemPrompt.getState().open(summary.id)}>
              View system prompt
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
    </>
  );
}
