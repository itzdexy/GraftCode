import { create } from 'zustand';

export type SettingsSection =
  | 'profile'
  | 'providers'
  | 'models'
  | 'permissions'
  | 'privacy'
  | 'search'
  | 'mcp'
  | 'hooks'
  | 'memory'
  | 'appearance'
  | 'shortcuts'
  | 'notifications'
  | 'data'
  | 'about';

export type Route =
  | { name: 'home' }
  | { name: 'session'; id: string }
  | { name: 'projects' }
  | { name: 'artifacts' }
  | { name: 'scheduled' }
  | { name: 'customize' }
  | { name: 'settings'; section: SettingsSection };

const MAX_HISTORY = 50;

function same(a: Route, b: Route): boolean {
  if (a.name !== b.name) return false;
  if (a.name === 'session' && b.name === 'session') return a.id === b.id;
  if (a.name === 'settings' && b.name === 'settings') return a.section === b.section;
  return true;
}

interface NavState {
  route: Route;
  back: Route[];
  forward: Route[];
  go: (route: Route) => void;
  goBack: () => void;
  goForward: () => void;
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
