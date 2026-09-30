import { useMemo, useState, type ReactNode } from 'react';
import { Plus, Search } from 'lucide-react';
import type { SessionSummary } from '@shared/schemas/sessions';
import { IconButton } from '../../components/Button';
import { cn } from '../../lib/cn';
import { useShortcutLabel } from '../../lib/shortcuts';
import { useNow } from '../../lib/time';
import { useApp } from '../../stores/app';
import { useNav, type Route } from '../../stores/nav';
import { useSessions } from '../../stores/sessions';
import { reportError } from '../../stores/toasts';
import { useUi } from '../../stores/ui';
import { newSessionIn } from '../home/codeContext';
import { FilterPopover } from './FilterPopover';
import { groupByProject, visibleSessions } from './sessionLists';
import { SessionRow } from './SessionRow';
import { SidebarFooter } from './SidebarFooter';
import { SidebarResizer } from './SidebarResizer';
import { startNew } from './shellActions';
import { TitlebarControls } from './TitlebarControls';

const CHAT_LIST_LIMIT = 20;

interface NavEntry {
  id: string;
  label: string;
  icon: ReactNode;
  route: Route;
  isActive: (route: Route) => boolean;
  onSelect?: () => void;
}

function NavRow({ entry, active }: { entry: NavEntry; active: boolean }) {
  return (
    <li>
      <button
        type="button"
        aria-current={active ? 'page' : undefined}
        onClick={() => (entry.onSelect ? entry.onSelect() : useNav.getState().go(entry.route))}
        className={cn(
          'mx-[var(--g-sidebar-inset)] flex h-[var(--g-nav-row-height)] w-[calc(100%-2*var(--g-sidebar-inset))] items-center gap-8 rounded-md px-6 text-left text-base transition-ui',
          active ? 'bg-selected text-fg-strong' : 'text-fg-secondary hover:bg-sidebar-hover hover:text-fg'
        )}
      >
        <span className="flex size-14 shrink-0 items-center justify-center text-icon">{entry.icon}</span>
        <span className="truncate">{entry.label}</span>
      </button>
    </li>
  );
}

function ListHeader({ label, detail, children }: { label: string; detail?: string | null; children?: ReactNode }) {
  return (
    <div className="flex h-24 items-center gap-4 pr-[calc(var(--g-sidebar-inset)+4px)] pl-13">
      <h2 className="min-w-0 flex-1 truncate text-xs font-normal text-fg-muted" title={detail ?? undefined}>
        {label}
        {detail ? <span className="text-fg-faint"> · {detail}</span> : null}
      </h2>
      {children}
    </div>
  );
}

function EmptyList({ text }: { text: string }) {
  return <p className="px-13 py-6 text-sm text-fg-faint">{text}</p>;
}

function SearchButton() {
  const shortcut = useShortcutLabel('search');
  return (
    <IconButton label="Search" shortcut={shortcut} size="xs" onClick={() => useUi.getState().setSearchOpen(true)}>
      <Search className="size-14" />
    </IconButton>
  );
}

function ChatList({ sessions, activeId }: { sessions: SessionSummary[]; activeId: string | null }) {
  const expanded = useUi((s) => s.chatListExpanded);
  const shown = expanded ? sessions : sessions.slice(0, CHAT_LIST_LIMIT);
  return (
    <section aria-label="Chats and tasks" className="mt-24">
      <ListHeader label="Chats and tasks">
        <SearchButton />
        <FilterPopover kind="chat" />
      </ListHeader>
      {sessions.length === 0 ? <EmptyList text="No chats here yet." /> : null}
      <ul className="flex flex-col">
        {shown.map((s) => (
          <SessionRow key={s.id} session={s} active={s.id === activeId} />
        ))}
      </ul>
      {sessions.length > CHAT_LIST_LIMIT ? (
        <button
          type="button"
          onClick={() => useUi.getState().setChatListExpanded(!expanded)}
          className="mx-[var(--g-sidebar-inset)] mt-2 flex h-[var(--g-list-row-height)] items-center rounded-md px-7 text-base text-fg-muted transition-ui hover:text-fg-secondary"
        >
          {expanded ? 'Show less' : 'View all'}
        </button>
      ) : null}
    </section>
  );
}

function CodeList({ sessions, activeId }: { sessions: SessionSummary[]; activeId: string | null }) {
  const groups = useMemo(() => groupByProject(sessions), [sessions]);
  if (groups.length === 0) {
    return (
      <section aria-label="Sessions" className="mt-24">
        <ListHeader label="Sessions">
          <SearchButton />
          <FilterPopover kind="code" />
        </ListHeader>
        <EmptyList text="No sessions here yet." />
      </section>
    );
  }
  return (
    <div className="mt-24 flex flex-col gap-8">
      {groups.map((group, i) => (
        <section key={group.key} aria-label={group.name}>
          <ListHeader label={group.name} detail={group.detail}>
            {group.path ? (
              <IconButton
                label={`New session in ${group.name}`}
                size="xs"
                onClick={() => {
                  if (group.path) newSessionIn(group.path).catch((e: unknown) => reportError("Couldn't open that folder", e));
                }}
              >
                <Plus className="size-14" />
              </IconButton>
            ) : null}
            {i === 0 ? (
              <>
                <SearchButton />
                <FilterPopover kind="code" />
              </>
            ) : null}
          </ListHeader>
          <ul className="flex flex-col">
            {group.sessions.map((s) => (
              <SessionRow key={s.id} session={s} active={s.id === activeId} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** Left sidebar: navigation, the session list for the current mode, and the account footer. */
export function Sidebar() {
  const mode = useApp((s) => s.settings?.ui.mode ?? 'code');
  const storedWidth = useApp((s) => s.settings?.ui.sidebarWidth ?? 262);
  const [preview, setPreview] = useState<number | null>(null);
  const route = useNav((s) => s.route);
  const summaries = useSessions((s) => s.summaries);
  const loaded = useSessions((s) => s.loaded);
  const filter = useUi((s) => s.filter);
  const width = preview ?? storedWidth;

  const now = useNow(60_000);
  const sessions = useMemo(() => visibleSessions(Object.values(summaries), mode, filter, now), [summaries, mode, filter, now]);
  const activeId = route.name === 'session' ? route.id : null;

  const nav: NavEntry[] = [
    {
      id: 'new',
      label: 'New',
      icon: <Plus className="size-14" />,
      route: { name: 'home' },
      isActive: (r) => r.name === 'home',
      onSelect: startNew
    }
  ];

  const commitWidth = (next: number): void => {
    useApp
      .getState()
      .updateSettings({ ui: { sidebarWidth: next } })
      .catch((e: unknown) => reportError("Couldn't save the sidebar width", e));
  };

  return (
    <aside aria-label="Sidebar" className="relative flex h-full shrink-0 flex-col border-r border-border-subtle bg-sidebar" style={{ width }}>
      <div className="app-drag flex h-[var(--g-titlebar-height)] shrink-0 items-center pr-[var(--g-sidebar-inset)] pl-[calc(var(--g-controls-left)+var(--g-sidebar-inset))]">
        <TitlebarControls className="flex-1" />
      </div>
      <nav aria-label="Main" className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto pt-8 pb-12">
        <ul className="flex flex-col">
          {nav.map((entry) => (
            <NavRow key={entry.id} entry={entry} active={entry.isActive(route)} />
          ))}
        </ul>
        {loaded ? (
          mode === 'chat' ? (
            <ChatList sessions={sessions} activeId={activeId} />
          ) : (
            <CodeList sessions={sessions} activeId={activeId} />
          )
        ) : null}
      </nav>
      <SidebarFooter />
      <SidebarResizer width={width} onPreview={setPreview} onCommit={commitWidth} />
    </aside>
  );
}
