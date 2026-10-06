import type { ReactNode } from 'react';
import { AtSign, Code, Copy, ExternalLink, FolderOpen, Image, Link2, MoreHorizontal } from 'lucide-react';
import { IconButton } from '../../components/Button';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../../components/Menu';
import { cn } from '../../lib/cn';
import { invoke } from '../../lib/ipc';
import { useSessions } from '../../stores/sessions';
import { notify, reportError } from '../../stores/toasts';
import { useUi } from '../../stores/ui';
import { absolutePath, actionsFor, withMention, type FileAction } from './fileActions';

export interface FileTarget {
  /** Relative to the session's folder, "/"-separated. */
  path: string;
  type: 'file' | 'dir';
}

const LABELS: Record<FileAction, { label: string; icon: ReactNode }> = {
  'copy-path': { label: 'Copy path', icon: <Copy className="size-14" /> },
  'copy-relative': { label: 'Copy relative path', icon: <Link2 className="size-14" /> },
  'copy-image': { label: 'Copy picture', icon: <Image className="size-14" /> },
  reveal: { label: 'Show in folder', icon: <FolderOpen className="size-14" /> },
  open: { label: 'Open with its app', icon: <ExternalLink className="size-14" /> },
  editor: { label: 'Open in editor', icon: <Code className="size-14" /> },
  mention: { label: 'Add to message', icon: <AtSign className="size-14" /> }
};

function copyText(text: string, what: string): void {
  navigator.clipboard.writeText(text).then(
    () => notify(`${what} copied`, text),
    (error: unknown) => reportError("Couldn't copy to the clipboard", error)
  );
}

/** Carries out a file action for a session: its folder gives the full path. */
export function useFileActions(sessionId: string): (action: FileAction, target: FileTarget) => void {
  const folder = useSessions((s) => {
    const summary = s.summaries[sessionId];
    return summary ? (summary.worktreePath ?? summary.cwd) : null;
  });
  return (action, target) => {
    const name = target.path.slice(target.path.lastIndexOf('/') + 1) || 'the folder';
    const full = folder ? absolutePath(folder, target.path, window.graft.platform) : null;
    const failed = (what: string) => (error: unknown) => reportError(what, error);
    switch (action) {
      case 'copy-path':
        if (full) copyText(full, 'Path');
        return;
      case 'copy-relative':
        copyText(target.path, 'Relative path');
        return;
      case 'copy-image':
        invoke('files:copyImage', { sessionId, path: target.path }).then(() => notify('Picture copied', name), failed(`Couldn't copy ${name}`));
        return;
      case 'reveal':
        if (full) invoke('app:revealPath', { path: full }).catch(failed(`Couldn't show ${name}`));
        return;
      case 'open':
        invoke('files:open', { sessionId, path: target.path }).catch(failed(`Couldn't open ${name}`));
        return;
      case 'editor':
        if (full) invoke('app:openInEditor', { path: full }).catch(failed(`Couldn't open ${name} in the editor`));
        return;
      case 'mention': {
        const ui = useUi.getState();
        ui.setDraft(sessionId, withMention(ui.drafts[sessionId] ?? '', target.path));
        ui.focusComposer?.();
        return;
      }
    }
  };
}

/** The "…" menu of a file or folder: its paths, its folder, the apps that open it, and the message box. */
export function FileMenu({
  sessionId,
  target,
  open,
  onOpenChange,
  className
}: {
  sessionId: string;
  target: FileTarget;
  /** Controlled when a right-click opens it; otherwise the button does. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}) {
  const run = useFileActions(sessionId);
  const name = target.path.slice(target.path.lastIndexOf('/') + 1);
  return (
    <Menu {...(open !== undefined ? { open } : {})} {...(onOpenChange ? { onOpenChange } : {})}>
      <MenuTrigger asChild>
        <IconButton label={`Options for ${name}`} size="xs" className={cn(className)}>
          <MoreHorizontal className="size-14" />
        </IconButton>
      </MenuTrigger>
      <MenuContent align="end" aria-label={`Options for ${name}`}>
        {actionsFor(target).map((action) => (
          <MenuItem key={action} icon={LABELS[action].icon} onSelect={() => run(action, target)}>
            {LABELS[action].label}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}
