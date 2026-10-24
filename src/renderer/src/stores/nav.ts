import { create } from 'zustand';

/** The tabs of Customize (a route can open one directly). */
export type CustomizeTabId = 'commands' | 'agents' | 'skills' | 'mcp' | 'checks' | 'hooks' | 'memory';

export type SettingsSection =
  | 'profile'
  | 'personalization'
  | 'providers'
  | 'models'
  | 'permissions'
  | 'sandbox'
  | 'media'
  | 'privacy'
  | 'search'
  | 'voice'
  | 'mcp'
  | 'hooks'
  | 'memory'
  | 'appearance'
  | 'shortcuts'
  | 'notifications'
  | 'usage'
  | 'data'
  | 'about';

export type Route =
  | { name: 'home' }
  | { name: 'session'; id: string }
  | { name: 'projects' }
  | { name: 'artifacts' }
  | { name: 'sites' }
  | { name: 'scheduled' }
  | { name: 'customize'; tab?: CustomizeTabId }
  | { name: 'settings'; section: SettingsSection };

const MAX_HISTORY = 50;

function same(a: Route, b: Route): boolean {
  if (a.name !== b.name) return false;
  if (a.name === 'session' && b.name === 'session') return a.id === b.id;
  if (a.name === 'settings' && b.name === 'settings') return a.section === b.section;
  return true;
}

/**
 * The page Settings lies over. Settings is a route, so links into it and the
 * history work as for any other, but it is drawn as a window over the newest
 * route in the history that is not Settings; over home when there is none.
 */
export function pageUnder(back: readonly Route[]): Route {
  return back.findLast((route) => route.name !== 'settings') ?? { name: 'home' };
}

interface NavState {
  route: Route;
  back: Route[];
  forward: Route[];
  go: (route: Route) => void;
  goBack: () => void;
  goForward: () => void;
  /** Leaves Settings for the page underneath, with the history as it was before Settings opened; the way back in is Forward. */
  closeSettings: () => void;
  /** Drops a removed session from history. */
  forget: (sessionId: string) => void;
}

/** Route plus browser-style back/forward history between views and sessions. */
export const useNav = create<NavState>((set, get) => ({
  route: { name: 'home' },
  back: [],
  forward: [],
  go(route) {
    const { route: current, back } = get();
    if (same(current, route)) return;
    set({ route, back: [...back, current].slice(-MAX_HISTORY), forward: [] });
  },
  goBack() {
    const { back, route, forward } = get();
    const previous = back.at(-1);
    if (!previous) return;
    set({ route: previous, back: back.slice(0, -1), forward: [route, ...forward] });
  },
  goForward() {
    const { back, route, forward } = get();
    const next = forward[0];
    if (!next) return;
    set({ route: next, back: [...back, route], forward: forward.slice(1) });
  },
  closeSettings() {
    const { route, back, forward } = get();
    if (route.name !== 'settings') return;
    // What pressing Back until the route is not Settings would do, as one change: the sections passed go to the front of Forward, in order.
    const under = back.findLastIndex((r) => r.name !== 'settings');
    set({ route: back[under] ?? { name: 'home' }, back: back.slice(0, Math.max(0, under)), forward: [...back.slice(under + 1), route, ...forward] });
  },
  forget(sessionId) {
    const keep = (r: Route): boolean => !(r.name === 'session' && r.id === sessionId);
    const { route, back, forward } = get();
    set({
      route: keep(route) ? route : { name: 'home' },
      back: back.filter(keep),
      forward: forward.filter(keep)
    });
  }
}));
