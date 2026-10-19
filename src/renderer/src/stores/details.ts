import { create } from 'zustand';
import { DETAIL_CARDS, FOLDED_AT_FIRST, type DetailCard } from '../features/session/details/detailsModel';

/** Whether the session details column is wanted, which of its cards are folded and which are taken out. Kept on this computer only. */
const STORAGE_KEY = 'graft.details.v1';

interface Stored {
  open: boolean;
  folded: DetailCard[];
  /** Taken out with the column's right-click menu, which puts them back. */
  hidden: DetailCard[];
}

const FIRST: Stored = { open: true, folded: [...FOLDED_AT_FIRST], hidden: [] };

/** The cards of a kept list that the column knows, in the column's order. */
const known = (value: unknown, otherwise: DetailCard[]): DetailCard[] =>
  Array.isArray(value) ? DETAIL_CARDS.filter((card) => (value as unknown[]).includes(card)) : otherwise;

/** What was kept, or the first state when nothing (or something unreadable) was. */
export function readDetails(storage: Pick<Storage, 'getItem'> | null): Stored {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return FIRST;
    const value = JSON.parse(raw) as Partial<Stored>;
    return { open: typeof value.open === 'boolean' ? value.open : FIRST.open, folded: known(value.folded, FIRST.folded), hidden: known(value.hidden, FIRST.hidden) };
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
  /** Puts a card in the column, or takes it out. */
  showCard: (card: DetailCard, shown: boolean) => void;
}

export const useDetails = create<DetailsState>((set, get) => ({
  ...readDetails(typeof window === 'undefined' ? null : window.localStorage),
  setOpen: (open) => {
    set({ open });
    keep({ open, folded: get().folded, hidden: get().hidden });
  },
  fold: (card, folded) => {
    const next = folded ? [...new Set([...get().folded, card])] : get().folded.filter((c) => c !== card);
    set({ folded: next });
    keep({ open: get().open, folded: next, hidden: get().hidden });
  },
  showCard: (card, shown) => {
    const next = shown ? get().hidden.filter((c) => c !== card) : DETAIL_CARDS.filter((c) => c === card || get().hidden.includes(c));
    set({ hidden: next });
    keep({ open: get().open, folded: get().folded, hidden: next });
  }
}));
