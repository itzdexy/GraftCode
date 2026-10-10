import { create } from 'zustand';
import type { FileAttachment, ImageBlock } from '@shared/schemas/messages';
import { DEFAULT_FILTER, type SessionFilter } from '../features/shell/sessionLists';
import { loadDrafts, mayStore, saveDrafts, trackPrivate } from '../lib/draftStore';
import { useSessions } from './sessions';

export interface CodeContext {
  projectPath: string | null;
  /** Base branch for a new worktree; null means the folder's current branch. */
  branch: string | null;
  useWorktree: boolean;
}

export type InfoDialog = 'shortcuts' | 'about' | null;

interface UiState {
  searchOpen: boolean;
  /** The command palette (Ctrl+Shift+P, or ">" in search) and the text it opens with. */
  paletteOpen: boolean;
  paletteQuery: string;
  moreOpen: boolean;
  chatListExpanded: boolean;
  /** The next chat started from Chat home is incognito (not saved). */
  incognito: boolean;
  filter: SessionFilter;
  /** Composer drafts keyed by "home:code", "home:chat" or a session id. They outlast a restart, except those of incognito chats. */
  drafts: Record<string, string>;
  codeContext: CodeContext | null;
  dialog: InfoDialog;
  /** Sessions whose git status bar the user dismissed (until the app restarts). */
  hiddenStatusBars: Record<string, true>;
  /** Focus callback registered by the composer currently on screen (Ctrl+L). */
  focusComposer: (() => void) | null;
  /** Attachments sent to a composer from elsewhere (the Browser panel), waiting for the composer with that draft key. */
  inbox: { key: string; images: ImageBlock[]; files: FileAttachment[] } | null;
  setSearchOpen: (open: boolean) => void;
  setPaletteOpen: (open: boolean, query?: string) => void;
  setMoreOpen: (open: boolean) => void;
  setChatListExpanded: (expanded: boolean) => void;
  setIncognito: (incognito: boolean) => void;
  setFilter: (filter: Partial<SessionFilter>) => void;
  resetFilter: () => void;
  setDraft: (key: string, text: string) => void;
  setCodeContext: (context: CodeContext) => void;
  setDialog: (dialog: InfoDialog) => void;
  hideStatusBar: (sessionId: string) => void;
  registerComposer: (focus: (() => void) | null) => void;
  sendToComposer: (key: string, add: { images?: ImageBlock[]; files?: FileAttachment[] }) => void;
  /** Hands the waiting attachments to the composer with this key (once). */
  takeInbox: (key: string) => { images: ImageBlock[]; files: FileAttachment[] } | null;
}

const storedDrafts = loadDrafts();
/** Drafts that were in storage at start: allowed there before, so kept until their session is seen to go. */
const storedAtStart = new Set(Object.keys(storedDrafts));
/** Drafts holding text typed in private (see trackPrivate): never written down. */
const privateDrafts = new Set<string>();

/** Writes the drafts to storage a moment after the last keystroke. */
let draftTimer: ReturnType<typeof setTimeout> | null = null;
function storeDraftsSoon(read: () => { drafts: Record<string, string> }): void {
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    draftTimer = null;
    const sessions = useSessions.getState().summaries;
    saveDrafts(read().drafts, (key) => mayStore(key, privateDrafts, sessions, storedAtStart));
  }, 400);
}

export const useUi = create<UiState>((set, get) => ({
  searchOpen: false,
  paletteOpen: false,
  paletteQuery: '',
  moreOpen: false,
  chatListExpanded: false,
  incognito: false,
  filter: DEFAULT_FILTER,
  drafts: storedDrafts,
  codeContext: null,
  dialog: null,
  hiddenStatusBars: {},
  focusComposer: null,
  inbox: null,
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  setPaletteOpen: (paletteOpen, paletteQuery = '') => set(paletteOpen ? { paletteOpen, paletteQuery, searchOpen: false } : { paletteOpen }),
  setMoreOpen: (moreOpen) => set({ moreOpen }),
  setChatListExpanded: (chatListExpanded) => set({ chatListExpanded }),
  setIncognito: (incognito) => {
    // What is in the Chat home box when the switch goes on is for an incognito chat from now on.
    if (incognito) trackPrivate(privateDrafts, 'home:chat', get().drafts['home:chat'] ?? '', true);
    set({ incognito });
    storeDraftsSoon(get);
  },
  setFilter: (filter) => set({ filter: { ...get().filter, ...filter } }),
  resetFilter: () => set({ filter: DEFAULT_FILTER }),
  setDraft: (key, text) => {
    trackPrivate(privateDrafts, key, text, key === 'home:chat' ? get().incognito : useSessions.getState().summaries[key]?.incognito === true);
    const drafts = { ...get().drafts };
    if (text.length === 0) delete drafts[key];
    else {
      // Set last, so the draft being typed counts as the newest when old ones are dropped.
      delete drafts[key];
      drafts[key] = text;
    }
    set({ drafts });
    storeDraftsSoon(get);
  },
  setCodeContext: (codeContext) => set({ codeContext }),
  setDialog: (dialog) => set({ dialog }),
  hideStatusBar: (sessionId) => set({ hiddenStatusBars: { ...get().hiddenStatusBars, [sessionId]: true } }),
  registerComposer: (focusComposer) => set({ focusComposer }),
  sendToComposer: (key, add) => {
    const current = get().inbox?.key === key ? get().inbox : null;
    set({ inbox: { key, images: [...(current?.images ?? []), ...(add.images ?? [])], files: [...(current?.files ?? []), ...(add.files ?? [])] } });
  },
  takeInbox: (key) => {
    const inbox = get().inbox;
    if (!inbox || inbox.key !== key) return null;
    set({ inbox: null });
    return { images: inbox.images, files: inbox.files };
  }
}));

// A draft goes with its session: when a chat is deleted, or history is cleared, nothing typed for it is kept.
useSessions.subscribe((state, previous) => {
  if (state.summaries === previous.summaries) return;
  const gone = Object.keys(previous.summaries).filter((id) => !(id in state.summaries));
  if (gone.length === 0) return;
  const drafts = { ...useUi.getState().drafts };
  for (const id of gone) {
    privateDrafts.delete(id);
    storedAtStart.delete(id);
    delete drafts[id];
  }
  useUi.setState({ drafts });
  storeDraftsSoon(() => useUi.getState());
});
