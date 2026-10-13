import { spawn } from 'node:child_process';
import { GraftError } from '@shared/errors';
import type { TextSearchMatch, TextSearchQuery, TextSearchResult } from '@shared/schemas/textSearch';

/**
 * Text search over a session's folder, for the Search tab. ripgrep does the
 * looking (what git ignores is skipped, and so is .git); its answer is read
 * as it arrives, so a search that finds far too much is stopped at the limit
 * instead of filling memory.
 */

/** No more lines than this are listed; the search is stopped there. */
export const MAX_MATCH_LINES = 2000;
/** A line is shown up to this length, around its first match. */
const PREVIEW_CHARS = 240;
/** What is shown before the first match of a long line. */
const PREVIEW_LEAD = 40;
const MAX_RANGES = 50;
/** One line of ripgrep's answer holds a whole line of a file: a longer one than this (a minified bundle) is passed over. */
const MAX_ANSWER_LINE = 4 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

export function searchArgs(query: TextSearchQuery): string[] {
  // --no-require-git: a .gitignore counts in a folder that is not a repository yet (a site Graft set up).
  const args = ['--json', '--no-config', '--hidden', '--no-require-git', '--sort', 'path', '--glob', '!.git'];
  for (const glob of query.files.split(',')) {
    const trimmed = glob.trim();
    if (trimmed.length > 0) args.push('--glob', trimmed);
  }
  args.push(query.caseSensitive ? '--case-sensitive' : '--ignore-case');
  if (query.wholeWord) args.push('--word-regexp');
  if (!query.regex) args.push('--fixed-strings');
  // The text follows --regexp, so one that starts with a dash is still the pattern.
  args.push('--regexp', query.text, '--', '.');
  return args;
}

/**
 * A line as a result shows it: its indentation gone, and when it is long,
 * the part around its first match. `spans` say where the matches are in
 * `line`; the ranges that come back say where they are in what is shown.
 */
export function previewOf(line: string, spans: Array<[number, number]>): { text: string; ranges: Array<[number, number]> } {
  const first = spans[0]?.[0] ?? 0;
  const lead = Math.min(line.length - line.trimStart().length, first);
  let start = lead;
  let end = line.length;
  if (end - lead > PREVIEW_CHARS) {
    start = Math.max(lead, first - PREVIEW_LEAD);
    end = Math.min(line.length, start + PREVIEW_CHARS);
    // Never half of a character that takes two units.
    if (isLowSurrogate(line.charCodeAt(start))) start++;
    if (isHighSurrogate(line.charCodeAt(end - 1))) end--;
  }
  const before = start > lead ? '…' : '';
  const after = end < line.length ? '…' : '';
  const ranges: Array<[number, number]> = [];
  for (const [from, to] of spans) {
    if (from >= end || to <= start || ranges.length >= MAX_RANGES) continue;
    ranges.push([Math.max(from, start) - start + before.length, Math.min(to, end) - start + before.length]);
  }
  return { text: `${before}${line.slice(start, end)}${after}`, ranges };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** ripgrep gives text as `{ text }`, and what is not valid UTF-8 as `{ bytes }` in base64. */
function bytesOf(value: unknown): Buffer | null {
  if (typeof value !== 'object' || value === null) return null;
  const { text, bytes } = value as { text?: unknown; bytes?: unknown };
  if (typeof text === 'string') return Buffer.from(text, 'utf8');
  if (typeof bytes === 'string') return Buffer.from(bytes, 'base64');
  return null;
}

/** One line of ripgrep's JSON answer as a result, or null when it is not a match. */
export function matchOf(event: unknown): { path: string; match: TextSearchMatch } | null {
  if (typeof event !== 'object' || event === null || (event as { type?: unknown }).type !== 'match') return null;
  const data = (event as { data?: { path?: unknown; lines?: unknown; line_number?: unknown; submatches?: unknown } }).data;
  const file = bytesOf(data?.path);
  const bytes = bytesOf(data?.lines);
  if (!data || !file || !bytes || typeof data.line_number !== 'number' || !Array.isArray(data.submatches)) return null;
  // ripgrep counts in bytes; the editor and the marks count in characters.
  const chars = (offset: number): number => bytes.subarray(0, offset).toString('utf8').length;
  const line = bytes.toString('utf8').replace(/\r?\n$/, '');
  const spans: Array<[number, number]> = [];
  for (const sub of data.submatches as Array<{ start?: unknown; end?: unknown }>) {
    if (typeof sub.start !== 'number' || typeof sub.end !== 'number' || sub.end <= sub.start) continue;
    spans.push([Math.min(chars(sub.start), line.length), Math.min(chars(sub.end), line.length)]);
  }
  const path = file.toString('utf8').replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
  return { path, match: { line: data.line_number, column: (spans[0]?.[0] ?? 0) + 1, ...previewOf(line, spans) } };
}

/** What ripgrep said was wrong, in one sentence: the last "error:" of a pattern it could not read, else its first line. */
function complaint(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const reason = [...lines].reverse().find((line) => line.startsWith('error:'));
  if (reason) return `That pattern can't be read: ${reason.slice('error:'.length).trim()}.`;
  return (lines[0] ?? 'The search failed.').replace(/^rg: /, '');
}

/**
 * Looks for `query` in the files under `root`. Resolves with what was found;
 * `truncated` says the search was stopped (the limit, the time, or `signal`).
 * Rejects with `bad_pattern` when ripgrep cannot read the pattern or a glob.
 */
export function searchText(rgPath: string, root: string, query: TextSearchQuery, signal?: AbortSignal): Promise<TextSearchResult> {
  return new Promise((resolve, reject) => {
    const files = new Map<string, TextSearchMatch[]>();
    let lines = 0;
    let truncated = false;
    let stderr = '';
    let pending = '';
    /** Inside a line of the answer that was too long to keep: skip to its end. */
    let skipping = false;
    const child = spawn(rgPath, searchArgs(query), { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = (): void => {
      truncated = true;
      child.kill();
    };
    const timer = setTimeout(stop, TIMEOUT_MS);
    if (signal?.aborted) stop();
    else signal?.addEventListener('abort', stop, { once: true });

    const take = (answer: string): void => {
      if (truncated || answer.length === 0) return;
      let event: unknown;
      try {
        event = JSON.parse(answer);
      } catch {
        return;
      }
      const found = matchOf(event);
      if (!found) return;
      const matches = files.get(found.path);
      if (matches) matches.push(found.match);
      else files.set(found.path, [found.match]);
      if (++lines >= MAX_MATCH_LINES) stop();
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      let rest = chunk;
      for (let at = rest.indexOf('\n'); at !== -1; at = rest.indexOf('\n')) {
        if (skipping) skipping = false;
        else take(pending + rest.slice(0, at));
        pending = '';
        rest = rest.slice(at + 1);
      }
      if (skipping) return;
      pending += rest;
      if (pending.length > MAX_ANSWER_LINE) {
        pending = '';
        skipping = true;
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 8000) stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      // 2 is ripgrep's "something was wrong": with nothing found, it is the pattern or a glob.
      if (code === 2 && !truncated && lines === 0) {
        reject(new GraftError('bad_pattern', complaint(stderr)));
        return;
      }
      resolve({ files: [...files].map(([path, matches]) => ({ path, matches })), lines, truncated });
    });
  });
}
