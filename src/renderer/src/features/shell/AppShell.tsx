import { useEffect } from 'react';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { ErrorState } from '../../components/States';
import { invoke } from '../../lib/ipc';
import { logError } from '../../lib/log';
import { useShortcut } from '../../lib/shortcuts';
import { useApp } from '../../stores/app';
import { useNav, type Route } from '../../stores/nav';
import { useSessions } from '../../stores/sessions';
import { reportError } from '../../stores/toasts';
import { useUi } from '../../stores/ui';
import { ArtifactsView } from '../artifacts/ArtifactsView';
import { CustomizeView } from '../customize/CustomizeView';
import { ChatHome } from '../home/ChatHome';
import { CodeHome } from '../home/CodeHome';
import { ProjectsView } from '../projects/ProjectsView';
import { ScheduledView } from '../scheduled/ScheduledView';
import { RewindDialog } from '../session/RewindDialog';
import { SessionView } from '../session/SessionView';
import { InfoDialogs } from './InfoDialogs';
import { SearchDialog } from './SearchDialog';
import { SessionDialogs } from './SessionDialogs';
import { Sidebar } from './Sidebar';
import { startNew, toggleSidebar } from './shellActions';

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
      return <ProjectsView />;
    case 'artifacts':
      return <ArtifactsView />;
    case 'scheduled':
      return <ScheduledView />;
    case 'customize':
      return <CustomizeView />;
    case 'settings':
      return <ErrorState title="Not available" message="This view isn't available." />;
  }
}

/** Main window after onboarding: sidebar, the routed view, and app-wide dialogs and shortcuts. */
export function AppShell() {
  const collapsed = useApp((s) => s.settings?.ui.sidebarCollapsed ?? false);
  const route = useNav((s) => s.route);
  const loaded = useSessions((s) => s.loaded);

  useEffect(() => {
    useSessions
      .getState()
      .loadList()
      .catch((e: unknown) => reportError("Couldn't load your sessions", e));
  }, []);

  const activeSession = route.name === 'session' ? route.id : null;
  useEffect(() => {
    invoke('sessions:setActive', { id: activeSession }).catch((e: unknown) => logError('Could not mark the active session', e));
  }, [activeSession]);

  useShortcut('newSession', () => startNew());
  useShortcut('search', () => useUi.getState().setSearchOpen(true));
  useShortcut('toggleSidebar', () => void toggleSidebar());
  useShortcut('focusComposer', () => useUi.getState().focusComposer?.());

  return (
    <div className="flex h-full bg-bg">
      {collapsed ? null : <Sidebar />}
      <main className="flex min-w-0 flex-1 flex-col">
        <ErrorBoundary label="This view" resetKey={routeKey(route)}>
          {loaded || route.name !== 'session' ? <RouteView route={route} /> : null}
        </ErrorBoundary>
      </main>
      <SearchDialog />
      <SessionDialogs />
      <RewindDialog />
      <InfoDialogs />
    </div>
  );
}
