import { useEditorDrafts } from './editorDrafts';

/** The draft to save, and the view that asked (so an answer for a file no longer shown isn't drawn over another). */
export interface SaveTarget {
  key: string;
  path: string;
  view: number;
}

/**
 * Saves of an editor's drafts, one at a time.
 *
 * What is written is the draft as it is when the save starts, read from the store. The editor
 * puts every keystroke there at once, while a render can still be a few keystrokes or a whole
 * save behind: a save that decided from a render's copy wrote an older draft, or did nothing
 * at all, when Ctrl+S came right behind the typing.
 *
 * A save asked for while another is on its way is not dropped. It starts when that one is
 * back, from the revision it returned.
 */
export function draftSaves<Saved extends { revision?: string }>(io: {
  write(target: SaveTarget, content: string, revision: string): Promise<Saved>;
  started(target: SaveTarget): void;
  saved(target: SaveTarget, result: Saved): void;
  failed(target: SaveTarget, error: unknown): void;
  settled(): void;
}): (target: SaveTarget) => void {
  let busy = false;
  let waiting: SaveTarget | null = null;

  const save = (target: SaveTarget): void => {
    if (busy) {
      waiting = target;
      return;
    }
    const draft = useEditorDrafts.getState().drafts[target.key];
    if (!draft || draft.content === draft.original) return;
    busy = true;
    io.started(target);
    void io
      .write(target, draft.content, draft.revision)
      .then(
        (result) => {
          if (result.revision) useEditorDrafts.getState().saved(target.key, draft.content, result.revision);
          io.saved(target, result);
        },
        (error: unknown) => io.failed(target, error)
      )
      .finally(() => {
        busy = false;
        io.settled();
        const next = waiting;
        waiting = null;
        if (next) save(next);
      });
  };
  return save;
}
