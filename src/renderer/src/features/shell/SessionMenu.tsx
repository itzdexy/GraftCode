import { Archive, ArchiveRestore, Copy, FileDown, Pencil, Pin, PinOff, Trash } from 'lucide-react';
import type { SessionSummary } from '@shared/schemas/sessions';
import { MenuItem, MenuSeparator, MenuSub, MenuSubContent, MenuSubTrigger } from '../../components/Menu';
import { duplicateSession, exportSession, setPinned, unarchiveSession } from './sessionActions';
import { useSessionDialog } from './SessionDialogs';

/** Items for a session's "⋮" menu: rename, pin, duplicate, export, archive, delete. */
export function SessionMenuItems({ session, onRename }: { session: SessionSummary; onRename: (() => void) | null }): JSX.Element {
  const openDialog = useSessionDialog((s) => s.open);
  return (
    <>
      {onRename ? (
        <MenuItem icon={<Pencil className="size-14" />} onSelect={onRename}>
          Rename
        </MenuItem>
      ) : null}
      {session.incognito ? null : (
        <MenuItem
          icon={session.pinned ? <PinOff className="size-14" /> : <Pin className="size-14" />}
          onSelect={() => void setPinned(session, !session.pinned)}
        >
          {session.pinned ? 'Unpin' : 'Pin'}
        </MenuItem>
      )}
      {session.incognito ? null : (
        <MenuItem icon={<Copy className="size-14" />} onSelect={() => void duplicateSession(session)}>
          Duplicate
        </MenuItem>
      )}
      <MenuSub>
        <MenuSubTrigger icon={<FileDown className="size-14" />}>Export</MenuSubTrigger>
        <MenuSubContent>
          <MenuItem onSelect={() => void exportSession(session, 'markdown')}>Markdown (.md)</MenuItem>
          <MenuItem onSelect={() => void exportSession(session, 'json')}>JSON (.json)</MenuItem>
        </MenuSubContent>
      </MenuSub>
      <MenuSeparator />
      {session.incognito ? null : session.archived ? (
        <MenuItem icon={<ArchiveRestore className="size-14" />} onSelect={() => void unarchiveSession(session)}>
          Unarchive
        </MenuItem>
      ) : (
        <MenuItem icon={<Archive className="size-14" />} onSelect={() => openDialog('archive', session)}>
          Archive
        </MenuItem>
      )}
      <MenuItem danger icon={<Trash className="size-14 text-danger" />} onSelect={() => openDialog('delete', session)}>
        Delete…
      </MenuItem>
    </>
  );
}
