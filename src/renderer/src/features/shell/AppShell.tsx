import { lazy, Suspense, useEffect } from 'react';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { ErrorState, LoadingState } from '../../components/States';
import { invoke } from '../../lib/ipc';
import { logError } from '../../lib/log';
import { usePresence } from '../../lib/motion';
import { useShortcut } from '../../lib/shortcuts';
import { useApp } from '../../stores/app';
import { useNav, type Route } from '../../stores/nav';
import { useSessions } from '../../stores/sessions';
import { useUi } from '../../stores/ui';
import { ChatHome } from '../home/ChatHome';
import { CodeHome } from '../home/CodeHome';
import { MissionDialog } from '../session/MissionDialog';
import { RewindDialog } from '../session/RewindDialog';
import { SessionView } from '../session/SessionView';
import { SystemPromptDialog } from '../session/SystemPromptDialog';
import { CommandPalette } from './CommandPalette';
import { InfoDialogs } from './InfoDialogs';
import { SearchDialog } from './SearchDialog';
import { SessionDialogs } from './SessionDialogs';
import { Sidebar } from './Sidebar';
import { openSettings, startNew, toggleSidebar } from './shellActions';

// Views opened now and then load on first use, which keeps startup light.
const ProjectsView = lazy(() => import('../projects/ProjectsView').then((m) => ({ default: m.ProjectsView })));
const ArtifactsView = lazy(() => import('../artifacts/ArtifactsView').then((m) => ({ default: m.ArtifactsView })));
const SitesView = lazy(() => import('../sites/SitesView').then((m) => ({ default: m.SitesView })));
const ScheduledView = lazy(() => import('../scheduled/ScheduledView').then((m) => ({ default: m.ScheduledView })));
const CustomizeView = lazy(() => import('../customize/CustomizeView').then((m) => ({ default: m.CustomizeView })));
const SettingsView = lazy(() => import('../settings/SettingsView').then((m) => ({ default: m.SettingsView })));

/** Matches --g-duration-base, the time the sidebar takes to slide away. */
const SIDEBAR_EXIT_MS = 180;

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
      return <SessionView key={route.id} sessionId={route.id} />;
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
      return <Later>{<SettingsView section={route.section} />}</Later>;
  }
}

function Later({ children }: { children: JSX.Element }) {
  return <Suspense fallback={<LoadingState className="h-full" />}>{children}</Suspense>;
}

/** Main window after onboarding: sidebar, the routed view, and app-wide dialogs and shortcuts. */
export function AppShell() {
  const collapsed = useApp((s) => s.settings?.ui.sidebarCollapsed ?? false);
  // The sidebar stays while it slides away (see .graft-slide-x), then leaves the page.
  const sidebarPresent = usePresence(!collapsed, SIDEBAR_EXIT_MS);
  const route = useNav((s) => s.route);
  const loaded = useSessions((s) => s.loaded);
  const loadError = useSessions((s) => s.loadError);

  useEffect(() => {
    void useSessions.getState().loadList();
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

  return (
    <div className="flex h-full bg-bg">
      <div className="graft-slide-x h-full shrink-0" data-state={collapsed ? 'closed' : 'open'}>
        {/* The column can only narrow around something without a width of its own; the sidebar keeps its width inside. */}
        <div>{sidebarPresent ? <Sidebar /> : null}</div>
      </div>
      <main className="flex min-w-0 flex-1 flex-col">
        <ErrorBoundary label="This view" resetKey={routeKey(route)}>
          {loadError ? (
            <ErrorState title="Couldn't load your sessions" message={loadError} onRetry={() => void useSessions.getState().loadList()} />
          ) : loaded || route.name !== 'session' ? (
            <RouteView route={route} />
          ) : null}
        </ErrorBoundary>
      </main>
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
