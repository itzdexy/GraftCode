import { useMemo, useState, type ReactNode } from 'react';
import { CalendarClock, ChevronDown, ChevronRight, EllipsisVertical, FolderClosed, PanelsTopLeft, Pencil, Plus, Search, Shapes, SlidersHorizontal, Trash } from 'lucide-react';
import type { SessionSummary } from '@shared/schemas/sessions';
import { IconButton } from '../../components/Button';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../../components/Menu';
import { cn } from '../../lib/cn';
import { useFlip } from '../../lib/flip';
import { useShortcutLabel } from '../../lib/shortcuts';
import { useNow } from '../../lib/time';
import { useApp } from '../../stores/app';
import { useNav, type Route } from '../../stores/nav';
import { useSessions } from '../../stores/sessions';
import { reportError } from '../../stores/toasts';
import { useUi } from '../../stores/ui';
import { newSessionIn } from '../home/codeContext';
import { FilterPopover } from './FilterPopover';
import { completedSessions, groupByProject, needsYou, splitGroups, visibleSessions, withoutThose, type GroupSection } from './sessionLists';
import { SessionRow } from './SessionRow';
import { useSessionDialog } from './SessionDialogs';
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

/** Search and the filter, in the topmost header of the lists. */
function ListControls({ kind }: { kind: 'chat' | 'code' }) {
  return (
    <>
      <SearchButton />
      <FilterPopover kind={kind} />
    </>
  );
}

/**
 * What waits for the user, above everything else: sessions with a question or an approval
 * open, or stopped with an error. A code session says which project it is in, since it is
 * not listed under it here.
 */
function NeedsYouList({ sessions, kind, activeId }: { sessions: SessionSummary[]; kind: 'chat' | 'code'; activeId: string | null }) {
  return (
    <section aria-label="Needs you">
      <ListHeader label="Needs you">
        <ListControls kind={kind} />
      </ListHeader>
      <ul className="flex flex-col">
        {sessions.map((s) => (
          <SessionRow key={s.id} session={s} active={s.id === activeId} detail={kind === 'code' ? s.projectName : null} />
        ))}
      </ul>
    </section>
  );
}

function ChatList({ sessions, activeId, controls }: { sessions: SessionSummary[]; activeId: string | null; controls: boolean }) {
  const expanded = useUi((s) => s.chatListExpanded);
  const shown = expanded ? sessions : sessions.slice(0, CHAT_LIST_LIMIT);
  return (
    <section aria-label="Chats and tasks">
      <ListHeader label="Chats and tasks">{controls ? <ListControls kind="chat" /> : null}</ListHeader>
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

function CodeList({ sessions, elsewhere, activeId, controls }: { sessions: SessionSummary[]; elsewhere: SessionSummary[]; activeId: string | null; controls: boolean }) {
  const groups = useMemo(() => groupByProject(sessions, elsewhere), [sessions, elsewhere]);
  if (groups.length === 0) {
    return (
      <section aria-label="Sessions">
        <ListHeader label="Sessions">{controls ? <ListControls kind="code" /> : null}</ListHeader>
        <EmptyList text="No sessions here yet." />
      </section>
    );
  }
  return (
    <div className="flex flex-col gap-8">
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
            {i === 0 && controls ? <ListControls kind="code" /> : null}
          </ListHeader>
          {group.sessions.length > 0 ? (
            <ul className="flex flex-col">
              {group.sessions.map((s) => (
                <SessionRow key={s.id} session={s} active={s.id === activeId} />
              ))}
            </ul>
          ) : (
            <EmptyList text={group.elsewhere === 1 ? 'Its session is under Needs you.' : `Its ${String(group.elsewhere)} sessions are under Needs you.`} />
          )}
        </section>
      ))}
    </div>
  );
}

/** A section header that folds: the chevron and the name toggle, the count says how many wait inside. */
function FoldHeader({ label, count, open, onToggle, children }: { label: string; count: number; open: boolean; onToggle: () => void; children?: ReactNode }) {
  return (
    <div className="flex h-24 items-center gap-4 pr-[calc(var(--g-sidebar-inset)+4px)] pl-9">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex h-full min-w-0 flex-1 items-center gap-4 rounded-md text-left"
      >
        {open ? (
          <ChevronDown className="size-12 shrink-0 text-icon-muted" aria-hidden="true" />
        ) : (
          <ChevronRight className="size-12 shrink-0 text-icon-muted" aria-hidden="true" />
        )}
        <h2 className="min-w-0 flex-1 truncate text-xs font-normal text-fg-muted">{label}</h2>
        <span className="px-2 text-xs text-fg-faint tabular-nums">{count}</span>
      </button>
      {children}
    </div>
  );
}

/** A named group of sessions the user filed together, folded or open, with its own menu. */
function GroupList({ section, kind, activeId, controls }: { section: GroupSection; kind: 'chat' | 'code'; activeId: string | null; controls: boolean }) {
  const collapsed = useUi((s) => s.collapsedGroups[section.group.id] === true);
  const openGroup = useSessionDialog((s) => s.openGroup);
  return (
    <section aria-label={section.group.name}>
      <FoldHeader label={section.group.name} count={section.sessions.length} open={!collapsed} onToggle={() => useUi.getState().toggleGroup(section.group.id)}>
        {controls ? <ListControls kind={kind} /> : null}
        <Menu>
          <MenuTrigger asChild>
            <IconButton label={`Actions for ${section.group.name}`} size="xs">
              <EllipsisVertical className="size-14" />
            </IconButton>
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem icon={<Pencil className="size-14" />} onSelect={() => openGroup({ kind: 'rename-group', group: section.group })}>
              Rename…
            </MenuItem>
            <MenuItem icon={<Trash className="size-14 text-danger" />} onSelect={() => openGroup({ kind: 'delete-group', group: section.group })}>
              Remove group…
            </MenuItem>
          </MenuContent>
        </Menu>
      </FoldHeader>
      {collapsed ? null : (
        <ul className="flex flex-col">
          {section.sessions.map((s) => (
            <SessionRow key={s.id} session={s} active={s.id === activeId} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** Sessions the user marked as completed: out of the way at the bottom, folded shut. */
function CompletedList({ sessions, activeId }: { sessions: SessionSummary[]; activeId: string | null }) {
  const open = useUi((s) => s.completedOpen);
  return (
    <section aria-label="Completed">
      <FoldHeader label="Completed" count={sessions.length} open={open} onToggle={() => useUi.getState().setCompletedOpen(!open)} />
      {open ? (
        <ul className="flex flex-col">
          {sessions.map((s) => (
            <SessionRow key={s.id} session={s} active={s.id === activeId} />
          ))}
        </ul>
      ) : null}
    </section>
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
  const groups = useSessions((s) => s.groups);
  const sessions = useMemo(() => visibleSessions(Object.values(summaries), mode, filter, now), [summaries, mode, filter, now]);
  const activeId = route.name === 'session' ? route.id : null;
  // What waits for the user elsewhere is listed once, at the top; the lists below go without it.
  const needing = useMemo(() => needsYou(Object.values(summaries), mode, filter, activeId), [summaries, mode, filter, activeId]);
  // Completed sessions wait at the bottom, in a section of their own.
  const completed = useMemo(() => completedSessions(Object.values(summaries), mode, filter, now), [summaries, mode, filter, now]);
  // Whatever the filter says, a session marked completed is never in a working list. An archived one is
  // raised only by the archived filter, where it stays: archiving is the stronger filing of the two.
  const finished = useMemo(() => Object.values(summaries).filter((s) => s.completedAt !== null && !s.archived), [summaries]);
  const rest = useMemo(() => withoutThose(withoutThose(sessions, needing), finished), [sessions, needing, finished]);
  // Sessions the user filed under a named group are listed there, not in their project or chat list.
  const filed = useMemo(() => splitGroups(groups, rest), [groups, rest]);
  // The search and filter controls sit in the first header that is shown.
  const listControls = needing.length === 0 && !(filed.sections.length > 0 && filed.rest.length === 0);
  // A session row that changes place (into or out of Needs you or Completed, or up its list after a new message) travels there.
  const lists = useFlip<HTMLElement>(
    [...needing, ...filed.sections.flatMap((section) => section.sessions), ...filed.rest, ...completed].map((s) => s.id).join(',')
  );

  const moreOpen = useUi((s) => s.moreOpen);
  const entry = (id: 'projects' | 'artifacts' | 'sites' | 'scheduled' | 'customize', label: string, icon: ReactNode): NavEntry => ({
    id,
    label,
    icon,
    route: { name: id },
    isActive: (r) => r.name === id
  });
  const projectsEntry = entry('projects', 'Projects', <FolderClosed className="size-14" />);
  const artifactsEntry = entry('artifacts', 'Artifacts', <Shapes className="size-14" />);
  const sitesEntry = entry('sites', 'Sites', <PanelsTopLeft className="size-14" />);
  const scheduledEntry = entry('scheduled', 'Scheduled', <CalendarClock className="size-14" />);
  const customizeEntry = entry('customize', 'Customize', <SlidersHorizontal className="size-14" />);
  const newEntry: NavEntry = { id: 'new', label: 'New', icon: <Plus className="size-14" />, route: { name: 'home' }, isActive: (r) => r.name === 'home', onSelect: startNew };
  // Chat mode shows everything; Code mode keeps the list short and folds the rest under More.
  const nav: NavEntry[] =
    mode === 'chat' ? [newEntry, projectsEntry, sitesEntry, artifactsEntry, scheduledEntry, customizeEntry] : [newEntry, sitesEntry, artifactsEntry, customizeEntry];
  const more: NavEntry[] = mode === 'chat' ? [] : [projectsEntry, scheduledEntry];

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
      <nav ref={lists} aria-label="Main" className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto pt-8 pb-12">
        <ul className="flex flex-col">
          {nav.map((e) => (
            <NavRow key={e.id} entry={e} active={e.isActive(route)} />
          ))}
          {more.length > 0 ? (
            <li>
              <button
                type="button"
                aria-expanded={moreOpen || more.some((e) => e.isActive(route))}
                onClick={() => useUi.getState().setMoreOpen(!moreOpen)}
                className="mx-[var(--g-sidebar-inset)] flex h-[var(--g-nav-row-height)] w-[calc(100%-2*var(--g-sidebar-inset))] items-center gap-8 rounded-md px-6 text-left text-base text-fg-muted transition-ui hover:bg-sidebar-hover hover:text-fg-secondary"
              >
                <span className="flex size-14 shrink-0 items-center justify-center text-icon-muted">
                  {moreOpen || more.some((e) => e.isActive(route)) ? <ChevronDown className="size-14" /> : <ChevronRight className="size-14" />}
                </span>
                More
              </button>
            </li>
          ) : null}
          {moreOpen || more.some((e) => e.isActive(route))
            ? more.map((e) => <NavRow key={e.id} entry={e} active={e.isActive(route)} />)
            : null}
        </ul>
        {loaded ? (
          <div className="mt-24 flex flex-col gap-8">
            {needing.length > 0 ? <NeedsYouList sessions={needing} kind={mode} activeId={activeId} /> : null}
            {filed.sections.map((section, i) => (
              // When the ordinary list below is empty (everything filed in groups), the controls sit in the first group.
              <GroupList key={section.group.id} section={section} kind={mode} activeId={activeId} controls={i === 0 && needing.length === 0 && filed.rest.length === 0} />
            ))}
            {/* With every session waiting or filed, there is no list below to call empty. */}
            {filed.rest.length === 0 && (needing.length > 0 || filed.sections.length > 0) ? null : mode === 'chat' ? (
              <ChatList sessions={filed.rest} activeId={activeId} controls={listControls} />
            ) : (
              <CodeList sessions={filed.rest} elsewhere={needing} activeId={activeId} controls={listControls} />
            )}
            {completed.length > 0 ? <CompletedList sessions={completed} activeId={activeId} /> : null}
          </div>
        ) : null}
      </nav>
      <SidebarFooter />
      <SidebarResizer width={width} onPreview={setPreview} onCommit={commitWidth} />
    </aside>
  );
}
