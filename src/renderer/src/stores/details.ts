import { create } from 'zustand';
import { DETAIL_CARDS, FOLDED_AT_FIRST, type DetailCard } from '../features/session/details/detailsModel';

/** Whether the session details column is wanted, and which of its cards are folded. Kept on this computer only. */
const STORAGE_KEY = 'graft.details.v1';

interface Stored {
  open: boolean;
  folded: DetailCard[];
}

const FIRST: Stored = { open: true, folded: [...FOLDED_AT_FIRST] };

/** What was kept, or the first state when nothing (or something unreadable) was. */
export function readDetails(storage: Pick<Storage, 'getItem'> | null): Stored {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return FIRST;
    const value = JSON.parse(raw) as Partial<Stored>;
    const folded = Array.isArray(value.folded) ? DETAIL_CARDS.filter((card) => value.folded?.includes(card)) : FIRST.folded;
    return { open: typeof value.open === 'boolean' ? value.open : FIRST.open, folded };
  } catch {
    return FIRST;
  }
}

function keep(state: Stored): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // rocky: without storage the column opens as it does the first time after a restart; nothing else depends on it.
  }
}

interface DetailsState extends Stored {
  setOpen: (open: boolean) => void;
  fold: (card: DetailCard, folded: boolean) => void;
}

export const useDetails = create<DetailsState>((set, get) => ({
  ...readDetails(typeof window === 'undefined' ? null : window.localStorage),
  setOpen: (open) => {
    set({ open });
    keep({ open, folded: get().folded });
  },
  fold: (card, folded) => {
    const next = folded ? [...new Set([...get().folded, card])] : get().folded.filter((c) => c !== card);
    set({ folded: next });
    keep({ open: get().open, folded: next });
  }
}));
