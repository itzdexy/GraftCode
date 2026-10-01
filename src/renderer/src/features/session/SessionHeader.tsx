import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ChevronDown, Clipboard, EllipsisVertical, FileDown, FolderOpen, Ghost, History, Laptop, ListChecks, Shrink } from 'lucide-react';
import type { SessionSummary } from '@shared/schemas/sessions';
import { Badge } from '../../components/Badge';
import { IconButton } from '../../components/Button';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../../components/Menu';
import { invoke } from '../../lib/ipc';
import { reportError, useToasts } from '../../stores/toasts';
import { exportSession, renameSession } from '../shell/sessionActions';
import { SessionMenuItems } from '../shell/SessionMenu';
import { ViewHeader } from '../shell/ViewHeader';

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
  busy: boolean;
  /** Panel toggles (terminal, changes, browser) placed before the menu. */
  panels?: ReactNode;
}

/** Code session header in the titlebar row: environment, title menu, project chip, panels and more. */
export function CodeSessionHeader({ summary, onCompact, onRewind, onShowTasks, busy, panels }: CodeHeaderProps) {
  const folder = summary.worktreePath ?? summary.cwd;
  return (
    <ViewHeader
      actions={
        <>
          {panels}
          <Menu>
            <MenuTrigger asChild>
              <IconButton label="More">
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
                <MenuItem icon={<ListChecks className="size-14" />} onSelect={onShowTasks}>
                  Background tasks
                </MenuItem>
              ) : null}
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
            </MenuContent>
          </Menu>
        </>
      }
    >
      <Laptop className="size-16 shrink-0 text-icon" aria-label="Runs on this computer" role="img" />
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
        {summary.incognito ? (
          <Badge icon={<Ghost className="size-10" aria-hidden="true" />}>Incognito · not saved</Badge>
        ) : null}
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
          </MenuContent>
        </Menu>
      </div>
    </>
  );
}
