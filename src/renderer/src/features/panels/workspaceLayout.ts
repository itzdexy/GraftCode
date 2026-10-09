import { z } from 'zod';

export const MAX_WORKSPACE_TABS = 24;
export const MAX_WORKSPACE_SESSIONS = 32;
export const WORKSPACE_LAYOUT_KEY = 'graft.workspace-layout.v1';
const MAX_STORED_LENGTH = 1024 * 1024;

const PathSchema = z.string().min(1).max(4096).refine((path) =>
  !/[\\:]/.test(path) && [...path].every((character) => character.charCodeAt(0) >= 32) && !path.startsWith('/') &&
  path.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && part !== '.git')
);
const TabSchema = z.object({ path: PathSchema, mode: z.enum(['preview', 'edit']) }).strict();
const LayoutSchema = z.object({ tabs: z.array(TabSchema).max(MAX_WORKSPACE_TABS), activePath: PathSchema.nullable() }).strict()
  .refine((layout) => new Set(layout.tabs.map((tab) => tab.path)).size === layout.tabs.length &&
    (layout.activePath === null ? layout.tabs.length === 0 : layout.tabs.some((tab) => tab.path === layout.activePath)));
const StoredSchema = z.object({ version: z.literal(1), sessions: z.array(z.object({
  id: z.string().min(1).max(256), updatedAt: z.number().int().nonnegative(), layout: LayoutSchema
}).strict()).max(MAX_WORKSPACE_SESSIONS) }).strict()
  .refine((value) => new Set(value.sessions.map((entry) => entry.id)).size === value.sessions.length);

export type WorkspaceTab = z.infer<typeof TabSchema>;
export type WorkspaceLayout = z.infer<typeof LayoutSchema>;
type StoredLayouts = z.infer<typeof StoredSchema>;
type LayoutStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function emptyWorkspaceLayout(): WorkspaceLayout { return { tabs: [], activePath: null }; }

/** Only relative paths, preview/edit modes and timestamps are persisted; drafts have their own recovery store. */
function readLayouts(storage: LayoutStorage): StoredLayouts {
  const raw = storage.getItem(WORKSPACE_LAYOUT_KEY);
  if (!raw || raw.length > MAX_STORED_LENGTH) return { version: 1, sessions: [] };
  try {
    const parsed = StoredSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : { version: 1, sessions: [] };
  } catch { return { version: 1, sessions: [] }; }
}

export function loadWorkspaceLayout(sessionId: string, storage?: LayoutStorage): WorkspaceLayout {
  try { return readLayouts(storage ?? localStorage).sessions.find((entry) => entry.id === sessionId)?.layout ?? emptyWorkspaceLayout(); }
  catch { return emptyWorkspaceLayout(); }
}

export function saveWorkspaceLayout(sessionId: string, layout: WorkspaceLayout, storage?: LayoutStorage): void {
  try {
    const target = storage ?? localStorage;
    const entry = StoredSchema.shape.sessions.element.parse({ id: sessionId, updatedAt: Date.now(), layout });
    const previous = readLayouts(target).sessions.filter((item) => item.id !== sessionId);
    const sessions = [entry, ...previous.sort((a, b) => b.updatedAt - a.updatedAt)].slice(0, MAX_WORKSPACE_SESSIONS);
    let raw = JSON.stringify({ version: 1, sessions });
    while (raw.length > MAX_STORED_LENGTH && sessions.length > 1) {
      sessions.pop(); raw = JSON.stringify({ version: 1, sessions });
    }
    if (raw.length <= MAX_STORED_LENGTH) target.setItem(WORKSPACE_LAYOUT_KEY, raw);
  } catch { /* A blocked/full storage must never interfere with editing or the separate draft backup. */ }
}

export function openWorkspaceTab(layout: WorkspaceLayout, path: string, mode: WorkspaceTab['mode']): WorkspaceLayout {
  if (!PathSchema.safeParse(path).success) return layout;
  const existing = layout.tabs.some((tab) => tab.path === path);
  const tabs = existing ? layout.tabs.map((tab) => tab.path === path ? { path, mode } : tab)
    : [...layout.tabs, { path, mode }].slice(-MAX_WORKSPACE_TABS);
  return { tabs, activePath: path };
}

export function closeWorkspaceTab(layout: WorkspaceLayout, path: string): WorkspaceLayout {
  const index = layout.tabs.findIndex((tab) => tab.path === path);
  if (index === -1) return layout;
  const tabs = layout.tabs.filter((tab) => tab.path !== path);
  const activePath = layout.activePath === path ? (tabs[Math.min(index, tabs.length - 1)]?.path ?? null) : layout.activePath;
  return { tabs, activePath };
}

export function setWorkspaceTabMode(layout: WorkspaceLayout, path: string, mode: WorkspaceTab['mode']): WorkspaceLayout {
  return { ...layout, tabs: layout.tabs.map((tab) => tab.path === path ? { ...tab, mode } : tab) };
}
