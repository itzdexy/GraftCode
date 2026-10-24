import { Archive, ArchiveRestore, Check, CircleCheck, Columns2, Copy, FileDown, FolderPlus, Pencil, Pin, PinOff, RotateCcw, Trash } from 'lucide-react';
import type { SessionSummary } from '@shared/schemas/sessions';
import { MenuItem, MenuSeparator, MenuSub, MenuSubContent, MenuSubTrigger } from '../../components/Menu';
import { useNav } from '../../stores/nav';
import { usePanes } from '../../stores/panes';
import { useSessions } from '../../stores/sessions';
import { duplicateSession, exportSession, setCompleted, setPinned, setSessionGroup, unarchiveSession } from './sessionActions';
import { useSessionDialog } from './SessionDialogs';

/** Items for a session's "⋮" menu: rename, open beside, pin, complete, file, duplicate, export, archive, delete. */
export function SessionMenuItems({ session, onRename }: { session: SessionSummary; onRename: (() => void) | null }): JSX.Element {
  const openDialog = useSessionDialog((s) => s.open);
  const openGroup = useSessionDialog((s) => s.openGroup);
  const groups = useSessions((s) => s.groups);
  const route = useNav((s) => s.route);
  const completed = session.completedAt !== null;
  // Beside what? Only a session that is open can have one opened beside it; this one is already there.
  const beside = !session.incognito && route.name === 'session' && route.id !== session.id;
  return (
    <>
      {onRename ? (
        <MenuItem icon={<Pencil className="size-14" />} onSelect={onRename}>
          Rename
        </MenuItem>
      ) : null}
      {beside ? (
        <MenuItem icon={<Columns2 className="size-14" />} onSelect={() => usePanes.getState().open(session.id)}>
          Open beside
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
      <MenuItem
        icon={completed ? <RotateCcw className="size-14" /> : <CircleCheck className="size-14" />}
        onSelect={() => void setCompleted(session, !completed)}
      >
        {completed ? 'Mark as in progress' : 'Mark as completed'}
      </MenuItem>
      {session.incognito ? null : (
        <MenuSub>
          <MenuSubTrigger icon={<FolderPlus className="size-14" />}>Move to group</MenuSubTrigger>
          <MenuSubContent className="min-w-[180px]">
            <MenuItem icon={session.groupId === null ? <Check className="size-14" /> : null} onSelect={() => void setSessionGroup(session, null)}>
              No group
            </MenuItem>
            {groups.map((group) => (
              <MenuItem
                key={group.id}
                icon={session.groupId === group.id ? <Check className="size-14" /> : null}
                onSelect={() => void setSessionGroup(session, group.id)}
              >
                {group.name}
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem icon={<FolderPlus className="size-14" />} onSelect={() => openGroup({ kind: 'new-group', session })}>
              New group…
            </MenuItem>
          </MenuSubContent>
        </MenuSub>
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
