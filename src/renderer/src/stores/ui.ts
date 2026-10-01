import { create } from 'zustand';
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
  setSearchOpen: (open: boolean) => void;
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
}

export const useUi = create<UiState>((set, get) => ({
  searchOpen: false,
  moreOpen: false,
  chatListExpanded: false,
  incognito: false,
  filter: DEFAULT_FILTER,
  drafts: {},
  codeContext: null,
  dialog: null,
  hiddenStatusBars: {},
  focusComposer: null,
  setSearchOpen: (searchOpen) => set({ searchOpen }),
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
  registerComposer: (focusComposer) => set({ focusComposer })
}));
