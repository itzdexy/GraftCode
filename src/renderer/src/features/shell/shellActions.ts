import { useApp } from '../../stores/app';
import { useNav } from '../../stores/nav';
import { reportError } from '../../stores/toasts';
import { useUi } from '../../stores/ui';

/** Shell-level commands used by menus, buttons and shortcuts. */

export async function toggleSidebar(): Promise<void> {
  const collapsed = useApp.getState().settings?.ui.sidebarCollapsed ?? false;
  try {
    await useApp.getState().updateSettings({ ui: { sidebarCollapsed: !collapsed } });
  } catch (error) {
    reportError("Couldn't toggle the sidebar", error);
  }
}

export async function setMode(mode: 'chat' | 'code'): Promise<void> {
  if (useApp.getState().settings?.ui.mode === mode) return;
  await useApp.getState().updateSettings({ ui: { mode } });
  const route = useNav.getState().route;
  if (route.name === 'home') return;
  useNav.getState().go({ name: 'home' });
}

/** Ctrl+N: go to the home screen of the current mode and focus its composer. */
export function startNew(): void {
  useNav.getState().go({ name: 'home' });
  // The home composer registers itself on mount; focus after the route renders.
  requestAnimationFrame(() => useUi.getState().focusComposer?.());
}
