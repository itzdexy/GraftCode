import { create } from 'zustand';
import type { FileAttachment, ImageBlock } from '@shared/schemas/messages';
import { DEFAULT_FILTER, type SessionFilter } from '../features/shell/sessionLists';

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
  /** Composer drafts keyed by "home:code", "home:chat" or a session id. */
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

export const useUi = create<UiState>((set, get) => ({
  searchOpen: false,
  paletteOpen: false,
  paletteQuery: '',
  moreOpen: false,
  chatListExpanded: false,
  incognito: false,
  filter: DEFAULT_FILTER,
  drafts: {},
  codeContext: null,
  dialog: null,
  hiddenStatusBars: {},
  focusComposer: null,
  inbox: null,
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  setPaletteOpen: (paletteOpen, paletteQuery = '') => set(paletteOpen ? { paletteOpen, paletteQuery, searchOpen: false } : { paletteOpen }),
  setMoreOpen: (moreOpen) => set({ moreOpen }),
  setChatListExpanded: (chatListExpanded) => set({ chatListExpanded }),
  setIncognito: (incognito) => set({ incognito }),
  setFilter: (filter) => set({ filter: { ...get().filter, ...filter } }),
  resetFilter: () => set({ filter: DEFAULT_FILTER }),
  setDraft: (key, text) => {
    const drafts = { ...get().drafts };
    if (text.length === 0) delete drafts[key];
    else drafts[key] = text;
    set({ drafts });
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
