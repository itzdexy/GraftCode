import { create } from 'zustand';

/** What the user did with a finding: sent it to be fixed (as a comment for the next message) or set it aside. */
export type FindingMark = 'fixed' | 'dismissed';

interface FindingMarksState {
  /** By finding key (see findingKey). */
  marks: Record<string, FindingMark>;
  /** Marks these findings; null takes the mark away. */
  mark: (keys: string[], mark: FindingMark | null) => void;
}

/** rocky: kept for as long as the window is open; a reopened app shows every finding open again, with any comment Fix made still waiting. */
export const useFindingMarks = create<FindingMarksState>((set) => ({
  marks: {},
  mark: (keys, mark) =>
    set((state) => {
      const marks = { ...state.marks };
      for (const key of keys) {
        if (mark) marks[key] = mark;
        else delete marks[key];
      }
      return { marks };
    })
}));
