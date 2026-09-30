import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { EllipsisVertical, Pin } from 'lucide-react';
import type { SessionSummary } from '@shared/schemas/sessions';
import { Menu, MenuContent, MenuTrigger } from '../../components/Menu';
import { cn } from '../../lib/cn';
import { useNav } from '../../stores/nav';
import { renameSession } from './sessionActions';
import { SessionMenuItems } from './SessionMenu';
import { SessionStatusIcon } from './SessionStatus';

/** One sidebar session row: status bullet, title, hover "⋮" menu, inline rename. */
export function SessionRow({ session, active }: { session: SessionSummary; active: boolean }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(session.title);
  const inputRef = useRef<HTMLInputElement>(null);
  const committed = useRef(false);
  const renameRequested = useRef(false);

  useEffect(() => {
    if (!renaming) return;
    committed.current = false;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [renaming]);

  const commit = (): void => {
    if (committed.current) return;
    committed.current = true;
    setRenaming(false);
    if (draft.trim() && draft.trim() !== session.title) void renameSession(session.id, draft);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      committed.current = true;
      setRenaming(false);
    }
  };

  return (
    <li
      className={cn(
        'group relative mx-[var(--g-sidebar-inset)] flex h-[var(--g-list-row-height)] items-center rounded-md transition-ui',
        active ? 'bg-selected' : 'hover:bg-sidebar-hover',
        menuOpen && !active && 'bg-sidebar-hover'
      )}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuOpen(true);
      }}
    >
      {renaming ? (
        <div className="flex h-full w-full items-center gap-8 pr-6 pl-7">
          <SessionStatusIcon session={session} />
          <input
            ref={inputRef}
            value={draft}
            maxLength={200}
            aria-label="Session title"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={commit}
            className="h-20 min-w-0 flex-1 rounded-xs border border-border-strong bg-input px-4 text-base text-fg outline-none"
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => useNav.getState().go({ name: 'session', id: session.id })}
          aria-current={active ? 'page' : undefined}
          className={cn(
            'flex h-full min-w-0 flex-1 items-center gap-8 rounded-md pr-28 pl-7 text-left text-base',
            active ? 'text-fg-strong' : 'text-fg-secondary'
          )}
        >
          <SessionStatusIcon session={session} />
          <span className="min-w-0 flex-1 truncate">{session.title}</span>
          {session.pinned ? <Pin className="size-12 shrink-0 text-icon-muted group-hover:hidden" aria-label="Pinned" /> : null}
        </button>
      )}
      {renaming ? null : (
        <Menu open={menuOpen} onOpenChange={setMenuOpen}>
          <MenuTrigger asChild>
            <button
              type="button"
              aria-label={`Options for ${session.title}`}
              className={cn(
                'absolute right-4 flex size-20 items-center justify-center rounded-xs text-icon transition-ui hover:bg-hover hover:text-icon-strong',
                menuOpen ? 'opacity-100' : 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100'
              )}
            >
              <EllipsisVertical className="size-14" />
            </button>
          </MenuTrigger>
          <MenuContent
            align="start"
            side="right"
            className="min-w-[200px]"
            onCloseAutoFocus={(e) => {
              if (renameRequested.current) {
                renameRequested.current = false;
                e.preventDefault();
              }
            }}
          >
            <SessionMenuItems
              session={session}
              onRename={() => {
                renameRequested.current = true;
                setDraft(session.title);
                setRenaming(true);
              }}
            />
          </MenuContent>
        </Menu>
      )}
    </li>
  );
}
