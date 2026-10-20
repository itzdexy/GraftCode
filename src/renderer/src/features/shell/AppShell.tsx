import { lazy, Suspense, useEffect, useState } from 'react';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { ErrorState, LoadingState } from '../../components/States';
import { invoke } from '../../lib/ipc';
import { logError } from '../../lib/log';
import { SLIDE_EXIT_MS, useCrossFaded, usePresence } from '../../lib/motion';
import { useShortcut } from '../../lib/shortcuts';
import { useApp } from '../../stores/app';
import { pageUnder, useNav, type Route, type SettingsSection } from '../../stores/nav';
import { usePanes } from '../../stores/panes';
import { useSessions } from '../../stores/sessions';
import { openSearch } from '../../stores/textSearch';
import { useUi } from '../../stores/ui';
import { ChatHome } from '../home/ChatHome';
import { CodeHome } from '../home/CodeHome';
import { MissionDialog } from '../session/MissionDialog';
import { RewindDialog } from '../session/RewindDialog';
import { SystemPromptDialog } from '../session/SystemPromptDialog';
import { CommandPalette } from './CommandPalette';
import { InfoDialogs } from './InfoDialogs';
import { SearchDialog } from './SearchDialog';
import { SessionDialogs } from './SessionDialogs';
import { SessionSplit } from './SessionSplit';
import { Sidebar } from './Sidebar';
import { openSettings, startNew, toggleSidebar } from './shellActions';

// Views opened now and then load on first use, which keeps startup light.
const ProjectsView = lazy(() => import('../projects/ProjectsView').then((m) => ({ default: m.ProjectsView })));
const ArtifactsView = lazy(() => import('../artifacts/ArtifactsView').then((m) => ({ default: m.ArtifactsView })));
const SitesView = lazy(() => import('../sites/SitesView').then((m) => ({ default: m.SitesView })));
const ScheduledView = lazy(() => import('../scheduled/ScheduledView').then((m) => ({ default: m.ScheduledView })));
const CustomizeView = lazy(() => import('../customize/CustomizeView').then((m) => ({ default: m.CustomizeView })));
const SettingsWindow = lazy(() => import('../settings/SettingsWindow').then((m) => ({ default: m.SettingsWindow })));

function routeKey(route: Route): string {
  if (route.name === 'session') return `session:${route.id}`;
  if (route.name === 'settings') return `settings:${route.section}`;
  return route.name;
}

function RouteView({ route }: { route: Route }) {
  const mode = useApp((s) => s.settings?.ui.mode ?? 'code');
  switch (route.name) {
    case 'home':
      return mode === 'code' ? <CodeHome /> : <ChatHome />;
    case 'session':
      return <SessionSplit key={route.id} id={route.id} />;
    case 'projects':
      return <Later>{<ProjectsView />}</Later>;
    case 'artifacts':
      return <Later>{<ArtifactsView />}</Later>;
    case 'sites':
      return <Later>{<SitesView />}</Later>;
    case 'scheduled':
      return <Later>{<ScheduledView />}</Later>;
    case 'customize':
      return <Later>{<CustomizeView key={route.tab ?? 'commands'} initialTab={route.tab ?? 'commands'} />}</Later>;
    case 'settings':
      // Settings is a window over a page (SettingsLayer), never the page itself.
      return null;
  }
}

function Later({ children }: { children: JSX.Element }) {
  return <Suspense fallback={<LoadingState className="h-full" />}>{children}</Suspense>;
}

/**
 * Settings, over whatever page is open. It loads the first time it is opened, and stays in the page for a moment
 * after it closes so that its leaving shows; the section it showed last is the one it leaves with.
 */
function SettingsLayer() {
  const route = useNav((s) => s.route);
  const open = route.name === 'settings';
  const present = usePresence(open);
  const [section, setSection] = useState<SettingsSection>('profile');
  if (route.name === 'settings' && route.section !== section) setSection(route.section);
  if (!present) return null;
  return (
    <Suspense fallback={null}>
      <SettingsWindow open={open} section={route.name === 'settings' ? route.section : section} />
    </Suspense>
  );
}

/** Main window after onboarding: sidebar, the routed view, and app-wide dialogs and shortcuts. */
export function AppShell() {
  const collapsed = useApp((s) => s.settings?.ui.sidebarCollapsed ?? false);
  // The sidebar stays while it slides away (see .graft-slide-x), then leaves the page.
  const sidebarPresent = usePresence(!collapsed, SLIDE_EXIT_MS);
  const route = useNav((s) => s.route);
  const back = useNav((s) => s.back);
  // The page that is drawn. Settings lies over the page it was opened from; and from one page to another the page
  // gives way (a cross-fade, or the new page rising in: see .graft-page), so the page drawn follows the route a frame
  // behind it while the route itself changes at once.
  const page = useCrossFaded(route.name === 'settings' ? pageUnder(back) : route, routeKey(route.name === 'settings' ? pageUnder(back) : route), 'page');
  const loaded = useSessions((s) => s.loaded);
  const loadError = useSessions((s) => s.loadError);

  useEffect(() => {
    void useSessions.getState().loadList();
    void useSessions.getState().loadGroups();
  }, []);

  const activeSession = route.name === 'session' ? route.id : null;
  useEffect(() => {
    invoke('sessions:setActive', { id: activeSession }).catch((e: unknown) => logError('Could not mark the active session', e));
  }, [activeSession]);

  useShortcut('newSession', () => startNew());
  useShortcut('search', () => useUi.getState().setSearchOpen(true));
  useShortcut('toggleSidebar', () => void toggleSidebar());
  useShortcut('focusComposer', () => useUi.getState().focusComposer?.());
  useShortcut('openSettings', () => openSettings());
  useShortcut('commandPalette', () => useUi.getState().setPaletteOpen(true));
  // A file and a symbol are opened by name in the code session on screen; elsewhere the keys are left alone.
  const inProject = useSessions((s) => {
    const session = activeSession ? s.summaries[activeSession] : undefined;
    return session?.kind === 'code' && (session.worktreePath ?? session.cwd) !== null;
  });
  // The open session is the main pane of a split; its keys step aside while the keyboard is in the other one.
  const mainFocused = usePanes((s) => s.side === null || s.focus === 'main');
  useShortcut('quickOpen', () => useUi.getState().setPaletteOpen(true, '', 'files'), inProject && mainFocused);
  useShortcut('goToSymbol', () => useUi.getState().setPaletteOpen(true, '', 'symbols'), inProject && mainFocused);
  useShortcut('searchFiles', () => (activeSession ? openSearch(activeSession) : undefined), inProject && mainFocused);

  return (
    <div className="flex h-full bg-bg">
      <div className="graft-slide-x h-full shrink-0" data-state={collapsed ? 'closed' : 'open'}>
        {/* The column can only narrow around something without a width of its own; the sidebar keeps its width inside. */}
        <div>{sidebarPresent ? <Sidebar /> : null}</div>
      </div>
      <main className="graft-page flex min-w-0 flex-1 flex-col">
        <ErrorBoundary label="This view" resetKey={routeKey(page)}>
          {loadError ? (
            <ErrorState title="Couldn't load your sessions" message={loadError} onRetry={() => void useSessions.getState().loadList()} />
          ) : loaded || page.name !== 'session' ? (
            <RouteView route={page} />
          ) : null}
        </ErrorBoundary>
      </main>
      <SettingsLayer />
      <SearchDialog />
      <CommandPalette />
      <SessionDialogs />
      <RewindDialog />
      <MissionDialog />
      <SystemPromptDialog />
      <InfoDialogs />
    </div>
  );
}
