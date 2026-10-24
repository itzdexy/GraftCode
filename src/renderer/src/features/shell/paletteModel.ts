/** What the palette is looking for: a command, a file by its name, or a symbol by its name (pure; unit-tested). */

import { fuzzyFilter } from '@shared/fuzzy';

export type PaletteMode = 'commands' | 'files' | 'symbols';

/** The files the language server knows: TypeScript and JavaScript, module flavours included. */
const TS_OR_JS = /\.(?:[cm]?[jt]s|[jt]sx)$/i;

/**
 * What a key press means in a mode. In the file palette, `>` first turns it
 * into the command palette and `@` first into the symbol palette, with the
 * rest of the text kept. The other two take everything typed as their query.
 */
export function paletteInput(mode: PaletteMode, typed: string): { mode: PaletteMode; query: string } {
  if (mode === 'files' && typed.startsWith('>')) return { mode: 'commands', query: typed.slice(1).trimStart() };
  if (mode === 'files' && typed.startsWith('@')) return { mode: 'symbols', query: typed.slice(1).trimStart() };
  return { mode, query: typed };
}

/** A file query and the line after it: `app.ts:42` opens the file at line 42. */
export function fileQuery(query: string): { text: string; line: number | null } {
  const typed = query.trim();
  const place = /^(.*?):(\d{0,7})$/.exec(typed);
  if (!place) return { text: typed, line: null };
  const line = Number(place[2] ?? '');
  return { text: (place[1] ?? '').trim(), line: line > 0 ? line : null };
}

/** How a file is listed: its name, and the folder it is in beside it. */
export function fileRow(path: string): { name: string; folder: string } {
  const cut = path.lastIndexOf('/');
  return { name: path.slice(cut + 1), folder: cut === -1 ? '' : path.slice(0, cut) };
}

/** The most files the file palette lists. */
export const FILES_SHOWN = 40;

/**
 * The files the file palette lists for what is typed: the answer for exactly that, else, while that answer is on its
 * way, the last one narrowed to what is typed now (as the search narrows it). Never an older query's rows as they
 * were: Enter opens the first row, and typing "greet" then Enter at once opened the folder's first file instead of
 * greet.ts. With nothing typed, the files open in the Files panel come first.
 */
export function filesShown(text: string, found: { text: string; paths: string[] } | null, tabs: readonly string[]): { paths: string[]; fresh: boolean } {
  const answered = found?.paths ?? [];
  const fresh = found !== null && found.text === text;
  if (text.length === 0) return { paths: [...tabs, ...answered.filter((path) => !tabs.includes(path))].slice(0, FILES_SHOWN), fresh };
  return { paths: fresh ? answered : fuzzyFilter(text, answered, (path) => path, FILES_SHOWN), fresh };
}

/**
 * The file that tells the language server which project a symbol search is
 * for: the file in front in the Files panel when it is TypeScript or
 * JavaScript, else the first such file of the project that is not a package's.
 */
export function anchorFile(active: string | null, files: readonly string[]): string | null {
  if (active !== null && TS_OR_JS.test(active)) return active;
  return files.find((file) => TS_OR_JS.test(file) && !`/${file}`.includes('/node_modules/')) ?? null;
}

/** The sentence the symbol palette shows when it has no rows. */
export function symbolMessage(state: 'untrusted' | 'no-files' | 'searching' | 'none', query: string): string {
  if (state === 'untrusted') return 'Go to symbol needs a trusted project.';
  if (state === 'no-files') return 'No TypeScript or JavaScript files here.';
  if (state === 'searching') return 'Searching…';
  return `No symbol matches "${query}".`;
}

/**
 * Takes requests one after another and passes on the answer of the newest
 * only: typing fast in a large project, an answer for an older query arrives
 * late and is dropped, never shown under the newer one. A failure is told the
 * same way, when it is the newest request that failed.
 */
export function latestOnly<T>(apply: (value: T) => void, fail?: (error: unknown) => void): (request: Promise<T>) => void {
  let newest = 0;
  return (request) => {
    const mine = ++newest;
    request.then(
      (value) => {
        if (mine === newest) apply(value);
      },
      (error: unknown) => {
        if (mine === newest) fail?.(error);
      }
    );
  };
}
