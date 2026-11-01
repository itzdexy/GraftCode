import { isPrivateAddress } from '@shared/privacy';
import { problemLine, problemsMessage } from '@shared/problems';
import type { ChangedProblems } from '@shared/schemas/semantic';
import { maskSecrets } from '@shared/secrets';
import { runGit } from '../git/git';
import type { PtyManager } from '../pty/ptyManager';
import { stripAnsi } from '../tools/shell/outputBuffer';
import { fetchText } from '../tools/web/webFetch';

/**
 * What the "@" mentions that are not files attach (agent/mentions.ts): the
 * folder's uncommitted diff, the Problems list, the end of the Terminal
 * panel and a web page. Each is text for the model, with keys and passwords
 * covered first.
 */

/** "@terminal" attaches this many of the panel's last lines… */
export const TERMINAL_LINES = 200;
/** …and no more than this many characters of them. */
const TERMINAL_CHARS = 40_000;
const DIFF_CHARS = 60_000;
const PROBLEM_LINES = 200;

export interface PageText {
  ok: boolean;
  /** The page, or why it wasn't read. */
  text: string;
}

/**
 * The folder's changes that are not committed: staged and unstaged together,
 * then the names of new files git doesn't track yet. Null when the folder is
 * not in a git repository; empty when nothing changed.
 */
export async function uncommittedDiff(dir: string, signal?: AbortSignal): Promise<string | null> {
  const options = { cwd: dir, allowFail: true, ...(signal ? { signal } : {}) };
  if ((await runGit(['rev-parse', '--show-toplevel'], options)).code !== 0) return null;
  // The repository's own diff programs and text filters are not run: they are commands the folder chose.
  const flags = ['--no-color', '--no-ext-diff', '--no-textconv', '-U3'];
  let diff = await runGit(['diff', 'HEAD', ...flags], options);
  // Before the first commit there is no HEAD: what is staged is all there is to compare.
  if (diff.code !== 0) diff = await runGit(['diff', '--cached', ...flags], options);
  const added = (await runGit(['ls-files', '--others', '--exclude-standard'], options)).stdout.split('\n').filter((line) => line.length > 0);
  const parts = [diff.stdout.trimEnd(), added.length > 0 ? `New files not added to git yet:\n${added.map((file) => `- ${file}`).join('\n')}` : ''].filter((part) => part.length > 0);
  const text = maskSecrets(parts.join('\n\n'));
  return text.length > DIFF_CHARS ? `${text.slice(0, DIFF_CHARS)}\n… [diff cut here: read the rest with git diff]` : text;
}

/**
 * The last lines a terminal printed, as text: colours and cursor moves taken
 * out, and a line redrawn in place (a progress bar) shown as it ended.
 */
export function terminalTail(output: string, count = TERMINAL_LINES): string {
  const lines = stripAnsi(output)
    .split('\n')
    .map((line) => {
      const text = line.replace(/\r+$/, '');
      // eslint-disable-next-line no-control-regex
      return text.slice(text.lastIndexOf('\r') + 1).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
    });
  // The prompt waiting for the next command is not output.
  while (lines.length > 0 && (lines.at(-1) ?? '').trim() === '') lines.pop();
  const tail = lines.slice(-count).join('\n');
  return maskSecrets(tail.length > TERMINAL_CHARS ? tail.slice(-TERMINAL_CHARS) : tail);
}

/** What the session's Terminal panel holds: the newest of its terminals still open, else the newest; null when it has none. */
export function sessionTerminal(ptys: Pick<PtyManager, 'list' | 'snapshot'> | null, sessionId: string): string | null {
  const terminals = ptys?.list(sessionId) ?? [];
  const chosen = terminals.findLast((t) => !t.exited) ?? terminals.at(-1);
  return ptys && chosen ? ptys.snapshot(chosen.id).data : null;
}

/** The Problems list as the tab says it, a problem a line. */
export function problemsText(result: ChangedProblems): string {
  const found = result.files.flatMap((file) => file.problems.map((problem) => `${problem.severity}: ${problemLine(file.path, problem)}`));
  const more = found.length - PROBLEM_LINES;
  return maskSecrets(
    [
      problemsMessage(result) ?? '',
      ...found.slice(0, PROBLEM_LINES),
      ...(more > 0 ? [`…and ${String(more)} more.`] : []),
      ...result.unchecked.map((file) => `Not checked: ${file.path} (${file.reason})`)
    ]
      .filter((line) => line.length > 0)
      .join('\n')
  );
}

/**
 * A page of the web as text, read by the code the agent's WebFetch uses. An
 * address on this computer or a private network is never read, nor is a name
 * that leads there or a redirect that does: a mention doesn't ask first.
 */
export async function pageText(url: string, signal: AbortSignal): Promise<PageText> {
  if (!URL.canParse(url) || !/^https?:$/i.test(new URL(url).protocol)) return { ok: false, text: `@${url} is not a web address, so it was not read.` };
  if (isPrivateAddress(url)) return { ok: false, text: `@${url} is on this computer or a private network, so it was not read. Ask for it with the agent's tools, which ask you first.` };
  const result = await fetchText({ url }, signal, true);
  const text = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
  return result.isError ? { ok: false, text: `@${url} was not read: ${text}` } : { ok: true, text: maskSecrets(text) };
}
