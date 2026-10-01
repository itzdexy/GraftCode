import type { ImageBlock, StoredMessage, ToolResultBlock } from '@shared/schemas/messages';
import type { TodoItem, ToolDisplay } from '@shared/schemas/toolDisplay';

/**
 * Turns stored messages into display items: consecutive tool calls collapse
 * into one group, tool results attach to their calls, and hidden bookkeeping
 * messages are dropped. Pure, so it is unit-tested without a DOM.
 */

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  result: ToolResultBlock | null;
  /** Live state while the tool runs (from tool-start / tool-progress events). */
  running: { summary: string; output: string } | null;
}

export type TranscriptItem =
  | { kind: 'user'; key: string; message: StoredMessage; text: string; images: ImageBlock[]; files: string[]; turn: number }
  | { kind: 'text'; key: string; messageId: string; text: string; live: boolean; endOfTurn: boolean; at: number }
  | { kind: 'thinking'; key: string; text: string; live: boolean; progress: boolean; at: number }
  | { kind: 'tools'; key: string; calls: ToolCall[]; at: number }
  | { kind: 'todos'; key: string; callId: string; todos: TodoItem[]; latest: boolean }
  | { kind: 'plan'; key: string; callId: string; plan: string; display: Extract<ToolDisplay, { kind: 'plan' }> | null }
  | { kind: 'provider'; key: string; summary: string; at: number; search: SearchInfo | null }
  | { kind: 'compaction'; key: string; text: string }
  | { kind: 'command-output'; key: string; text: string }
  | { kind: 'notice'; key: string; text: string }
  | { kind: 'error'; key: string; messageId: string; code: string; message: string }
  | { kind: 'interrupted'; key: string }
  | ActivityItem;

export interface SearchInfo {
  query: string;
  results: Array<{ title: string; url: string }>;
}

/** One step inside a turn's activity: narration, a thought, a tool call, a provider-side search or other action. */
export type ActivityStep =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'thinking'; key: string; text: string; live: boolean }
  | { kind: 'tool'; key: string; call: ToolCall }
  | { kind: 'search'; key: string; search: SearchInfo }
  | { kind: 'provider'; key: string; summary: string };

/** The work of a turn before its answer, folded into one block (Transcript shows it collapsed when done). */
export interface ActivityItem {
  kind: 'activity';
  key: string;
  steps: ActivityStep[];
  /** Still running: the newest group of the turn in progress. */
  live: boolean;
  /** When the turn started (its user message), and when this work ended. */
  startedAt: number | null;
  endedAt: number;
}

export interface LiveState {
  streaming: { messageId: string; text: string; thinking: string } | null;
  running: Record<string, { name: string; summary: string; output: string }>;
}

function inputOf<T extends Record<string, unknown>>(input: unknown): Partial<T> {
  return input && typeof input === 'object' ? input : {};
}

export function buildTranscript(messages: StoredMessage[], live: LiveState): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const calls = new Map<string, ToolCall>();
  let group: ToolCall[] | null = null;
  let groupKey = '';
  let groupAt = 0;
  let turn = 0;

  const flush = (): void => {
    if (group && group.length > 0) items.push({ kind: 'tools', key: groupKey, calls: group, at: groupAt });
    group = null;
  };

  for (const message of [...messages].sort((a, b) => a.seq - b.seq)) {
    const kind = message.meta.kind ?? 'normal';
    if (kind === 'reminder') continue;
    if (kind === 'compaction-summary') {
      flush();
      items.push({ kind: 'compaction', key: message.id, text: textFrom(message) });
      continue;
    }
    if (kind === 'command-output') {
      flush();
      items.push({ kind: 'command-output', key: message.id, text: textFrom(message) });
      continue;
    }
    if (kind === 'notice') {
      flush();
      items.push({ kind: 'notice', key: message.id, text: textFrom(message) });
      continue;
    }

    if (message.role === 'user') {
      for (const block of message.content) {
        if (block.type === 'tool_result') {
          const call = calls.get(block.toolUseId);
          if (call) call.result = block;
        }
      }
      const text = message.meta.typed ?? textFrom(message);
      const images = message.content.filter((b): b is ImageBlock => b.type === 'image');
      const files = message.meta.attachments ?? [];
      if (text.trim().length > 0 || images.length > 0 || files.length > 0) {
        flush();
        items.push({ kind: 'user', key: message.id, message, text, images, files, turn: turn++ });
      }
      continue;
    }

    message.content.forEach((block, index) => {
      const key = `${message.id}:${index}`;
      switch (block.type) {
        case 'text':
          if (block.text.trim().length > 0) {
            flush();
            items.push({ kind: 'text', key, messageId: message.id, text: block.text, live: false, endOfTurn: false, at: message.createdAt });
          }
          break;
        case 'thinking':
          if (block.text.trim().length > 0) {
            flush();
            items.push({ kind: 'thinking', key, text: block.text, live: false, progress: block.display === 'update', at: message.createdAt });
          }
          break;
        case 'tool_use': {
          const call: ToolCall = { id: block.id, name: block.name, input: block.input, result: null, running: null };
          calls.set(block.id, call);
          if (block.name === 'TodoWrite') {
            flush();
            const todos = inputOf<{ todos: TodoItem[] }>(block.input).todos;
            items.push({ kind: 'todos', key, callId: block.id, todos: Array.isArray(todos) ? todos : [], latest: false });
          } else if (block.name === 'ExitPlanMode') {
            flush();
            items.push({ kind: 'plan', key, callId: block.id, plan: String(inputOf<{ plan: string }>(block.input).plan ?? ''), display: null });
          } else {
            if (!group) {
              group = [];
              groupKey = key;
            }
            groupAt = message.createdAt;
            group.push(call);
          }
          break;
        }
        case 'provider':
          // Reasoning kept only for the provider's next request has no summary and stays hidden.
          if (block.summary.length > 0 || block.search) {
            flush();
            items.push({ kind: 'provider', key, summary: block.summary, at: message.createdAt, search: block.search ?? null });
          }
          break;
        case 'image':
        case 'redacted_thinking':
        case 'tool_result':
          break;
      }
    });
    if (message.meta.error) {
      flush();
      items.push({ kind: 'error', key: `${message.id}:error`, messageId: message.id, code: message.meta.error.code, message: message.meta.error.message });
    }
    if (message.meta.interrupted) {
      flush();
      items.push({ kind: 'interrupted', key: `${message.id}:interrupted` });
    }
  }
  flush();

  // Plans and todos pick up their results (approval, normalized list) after the fact.
  for (const item of items) {
    if (item.kind !== 'plan' && item.kind !== 'todos') continue;
    const display = calls.get(item.callId)?.result?.display;
    if (item.kind === 'plan' && display?.kind === 'plan') item.display = display;
    if (item.kind === 'todos' && display?.kind === 'todos') item.todos = display.todos;
  }
  const lastTodos = items.findLast((i) => i.kind === 'todos');
  if (lastTodos?.kind === 'todos') lastTodos.latest = true;

  for (const [id, state] of Object.entries(live.running)) {
    const call = calls.get(id);
    if (call && !call.result) call.running = { summary: state.summary, output: state.output };
  }

  if (live.streaming) {
    const s = live.streaming;
    const at = Date.now();
    if (s.thinking.trim().length > 0) items.push({ kind: 'thinking', key: `${s.messageId}:live-thinking`, text: s.thinking, live: true, progress: false, at });
    if (s.text.length > 0) items.push({ kind: 'text', key: `${s.messageId}:live`, messageId: s.messageId, text: s.text, live: true, endOfTurn: false, at });
  }

  // The last text before each user turn (or at the end) closes its turn; actions attach there.
  let sawUserAfter = true;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (!item) continue;
    if (item.kind === 'user') sawUserAfter = true;
    else if (item.kind === 'text' && sawUserAfter) {
      if (!item.live) item.endOfTurn = true;
      sawUserAfter = false;
    }
  }
  return items;
}

type WorkItem = Extract<TranscriptItem, { kind: 'text' | 'thinking' | 'tools' | 'provider' }>;

function isWork(item: TranscriptItem): item is WorkItem {
  return item.kind === 'text' || item.kind === 'thinking' || item.kind === 'tools' || item.kind === 'provider';
}

function stepsOf(item: WorkItem): ActivityStep[] {
  switch (item.kind) {
    case 'text':
      return [{ kind: 'text', key: item.key, text: item.text }];
    case 'thinking':
      // Progress updates are the model narrating, so they read as narration.
      return item.progress ? [{ kind: 'text', key: item.key, text: item.text }] : [{ kind: 'thinking', key: item.key, text: item.text, live: item.live }];
    case 'tools':
      return item.calls.map((call) => ({ kind: 'tool' as const, key: `${item.key}:${call.id}`, call }));
    case 'provider':
      return item.search ? [{ kind: 'search', key: item.key, search: { ...item.search, results: [...item.search.results] } }] : [{ kind: 'provider', key: item.key, summary: item.summary }];
  }
}

/** Adds steps, pairing a provider search's results with the query step just before them. */
function addSteps(steps: ActivityStep[], next: ActivityStep[]): void {
  for (const step of next) {
    const last = steps.at(-1);
    if (step.kind === 'search' && step.search.query === '' && last?.kind === 'search' && last.search.results.length === 0) {
      last.search.results = step.search.results;
      continue;
    }
    steps.push(step);
  }
}

/**
 * Folds each turn's work (narration, thinking, tool calls) into activity
 * blocks, leaving the turn's answer visible: the last text that nothing but
 * bookkeeping follows. While a turn runs, its streaming text stays outside
 * and the newest block is live. Todos, plans, errors and notices end a block.
 */
export function groupActivity(items: TranscriptItem[], turnActive: boolean): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  const turns: TranscriptItem[][] = [[]];
  for (const item of items) {
    if (item.kind === 'user') turns.push([item]);
    else turns.at(-1)?.push(item);
  }
  turns.forEach((segment, index) => {
    const lastTurn = index === turns.length - 1;
    const turnStart = out.length;
    const user = segment[0]?.kind === 'user' ? segment[0] : null;
    const startedAt = user?.kind === 'user' ? user.message.createdAt : null;
    // The answer: the last text with no work after it (a streaming text counts while it streams).
    let answer = -1;
    for (let i = segment.length - 1; i >= 0; i--) {
      const item = segment[i];
      if (!item || !isWork(item)) continue;
      if (item.kind === 'text' && (item.live || !(lastTurn && turnActive))) answer = i;
      break;
    }
    let steps: ActivityStep[] = [];
    let endedAt = startedAt ?? 0;
    let firstKey = '';
    const flush = (): void => {
      if (steps.length > 0) out.push({ kind: 'activity', key: `activity:${firstKey}`, steps, live: false, startedAt, endedAt });
      steps = [];
    };
    segment.forEach((item, i) => {
      if (item.kind === 'user') {
        out.push(item);
        return;
      }
      if (isWork(item) && i !== answer) {
        if (steps.length === 0) firstKey = item.key;
        addSteps(steps, stepsOf(item));
        endedAt = Math.max(endedAt, item.at);
        return;
      }
      flush();
      if (isWork(item)) endedAt = Math.max(endedAt, item.at);
      out.push(item);
    });
    flush();
    // The newest block of a turn in progress is still working, even while the answer streams after it.
    if (lastTurn && turnActive) {
      const block = out.slice(turnStart).findLast((o): o is ActivityItem => o.kind === 'activity');
      if (block) block.live = true;
    }
    // The answer arrived after the work: it closes the turn's last block.
    if (answer >= 0) {
      const item = segment[answer];
      const block = out.slice(turnStart).findLast((o): o is ActivityItem => o.kind === 'activity');
      if (item && isWork(item) && block) block.endedAt = Math.max(block.endedAt, item.at);
    }
  });
  return out;
}

/** Query and results of a WebSearch tool call (results empty until it finishes). */
export function searchOfCall(call: ToolCall): SearchInfo {
  const query = String(inputOf<{ query: string }>(call.input).query ?? '');
  const d = call.result?.display;
  return { query, results: d?.kind === 'web-search' ? d.results : [] };
}

/** "Searched 12 websites", counting each page once across searches. */
export function searchedPhrase(searches: SearchInfo[]): string {
  const sites = new Set(searches.flatMap((s) => s.results.map((r) => r.url))).size;
  if (sites > 0) return `Searched ${String(sites)} ${sites === 1 ? 'website' : 'websites'}`;
  return searches.length === 1 ? `Searched for “${searches[0]?.query ?? ''}”` : `Searched the web ${String(searches.length)} times`;
}

/** Lines added and removed by a set of tool calls (edits that went through). */
export function diffTotals(calls: ToolCall[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const call of calls) {
    const d = call.result?.display;
    if (d?.kind === 'edit' && !call.result?.isError) {
      added += d.added;
      removed += d.removed;
    }
  }
  return { added, removed };
}

export function durationText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${String(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${String(m)}m ${String(s % 60)}s`;
  return `${String(Math.floor(m / 60))}h ${String(m % 60)}m`;
}

/** Header for a finished block: what was done, or how long it took when it was only thinking. */
export function activityTitle(item: ActivityItem): string {
  const calls = item.steps.flatMap((s) => (s.kind === 'tool' ? [s.call] : []));
  const native = item.steps.flatMap((s) => (s.kind === 'search' ? [s.search] : []));
  const parts: string[] = [];
  if (native.length > 0) parts.push(searchedPhrase(native));
  if (calls.length > 0) parts.push(summarizeCalls(calls));
  if (parts.length > 0) return parts.map((p, i) => (i === 0 ? p : p.charAt(0).toLowerCase() + p.slice(1))).join(', ');
  const duration = item.startedAt === null ? 0 : item.endedAt - item.startedAt;
  const onlyThinking = item.steps.every((s) => s.kind === 'thinking');
  return `${onlyThinking ? 'Thought' : 'Worked'} for ${durationText(duration)}`;
}

function textFrom(message: StoredMessage): string {
  return message.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

// ---- tool summaries ---------------------------------------------------------

export function fileName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

function commandFailed(call: ToolCall): boolean {
  if (!call.result) return false;
  const d = call.result.display;
  if (d?.kind === 'shell') return d.timedOut || (d.exitCode !== null && d.exitCode !== 0);
  return call.result.isError;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many.replace('#', String(n));
}

/**
 * One muted line for a group of tool calls, most telling first:
 * "Ran 4 commands (1 failed), created a.ts, edited 2 files, read b.ts".
 */
export function summarizeCalls(calls: ToolCall[]): string {
  if (calls.length === 1) {
    const only = calls[0]!;
    const description = shellDescription(only);
    if (description && !commandFailed(only)) return description.charAt(0).toUpperCase() + description.slice(1);
  }
  const parts: string[] = [];
  const byName = (names: string[]): ToolCall[] => calls.filter((c) => names.includes(c.name));
  const pathsOf = (list: ToolCall[]): Set<string> => new Set(list.map((c) => String(inputOf<{ file_path: string }>(c.input).file_path ?? '')));
  const files = (verb: string, list: ToolCall[]): string => {
    const paths = pathsOf(list);
    return paths.size === 1 ? `${verb} ${fileName([...paths][0] ?? '')}` : `${verb} ${String(paths.size)} files`;
  };

  const commands = byName(['Shell']);
  if (commands.length > 0) {
    const failed = commands.filter(commandFailed).length;
    const background = commands.filter((c) => c.result?.display?.kind === 'shell' && c.result.display.backgroundId !== null).length;
    let phrase = plural(commands.length, 'Ran a command', 'Ran # commands');
    if (failed > 0) phrase += ` (${String(failed)} failed)`;
    if (background > 0) phrase += `, ${plural(background, 'started one in the background', 'started # in the background')}`;
    parts.push(phrase);
  }
  const allWrites = byName(['Write', 'Edit', 'MultiEdit']);
  if (allWrites.length > 0) {
    // Failed edits changed nothing, so they never count as edited.
    const declined = (c: ToolCall): boolean => c.result?.display?.kind === 'denied';
    const failed = allWrites.filter((c) => c.result?.isError === true && !declined(c));
    const writes = allWrites.filter((c) => c.result?.isError !== true && !declined(c));
    const created = writes.filter((c) => c.result?.display?.kind === 'edit' && c.result.display.created);
    const edited = writes.filter((c) => !created.includes(c));
    if (created.length > 0) parts.push(files('Created', created));
    if (edited.length > 0) parts.push(files('Edited', edited));
    if (failed.length > 0) parts.push(files("couldn't edit", failed));
  }
  const reads = byName(['Read']);
  if (reads.length > 0) parts.push(files('Read', reads));
  const greps = byName(['Grep']);
  if (greps.length > 0) {
    const pattern = String(inputOf<{ pattern: string }>(greps[0]!.input).pattern ?? '');
    parts.push(greps.length === 1 ? `Searched for “${pattern.length > 40 ? `${pattern.slice(0, 39)}…` : pattern}”` : `Ran ${String(greps.length)} searches`);
  }
  const globs = byName(['Glob']);
  if (globs.length > 0) parts.push(plural(globs.length, 'Listed files', 'Listed files # times'));
  const checks = byName(['ShellOutput']);
  if (checks.length > 0) {
    const finished = checks.filter((c) => c.result?.display?.kind === 'shell-output' && c.result.display.status !== 'running').length;
    parts.push(finished > 0 ? plural(finished, 'Finished a background command', 'Finished # background commands') : 'Checked a background command');
  }
  const kills = byName(['KillShell']);
  if (kills.length > 0) parts.push(plural(kills.length, 'Stopped a background command', 'Stopped # background commands'));
  const searches = byName(['WebSearch']);
  if (searches.length > 0) parts.push(searchedPhrase(searches.map(searchOfCall)));
  const fetches = byName(['WebFetch']);
  if (fetches.length > 0) {
    let host: string;
    try {
      host = new URL(String(inputOf<{ url: string }>(fetches[0]!.input).url ?? '')).hostname;
    } catch {
      host = 'a page';
    }
    parts.push(fetches.length === 1 ? `Fetched ${host}` : `Fetched ${String(fetches.length)} pages`);
  }
  const tasks = byName(['Task']);
  if (tasks.length > 0) {
    const description = String(inputOf<{ description: string }>(tasks[0]!.input).description ?? '');
    parts.push(tasks.length === 1 ? `Delegated: ${description}` : `Ran ${String(tasks.length)} sub-agents`);
  }
  const questions = byName(['AskUserQuestion']);
  if (questions.length > 0) parts.push('Asked you a question');
  const known = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'Shell', 'ShellOutput', 'KillShell', 'WebFetch', 'WebSearch', 'Task', 'AskUserQuestion']);
  const mcp = calls.filter((c) => c.name.startsWith('mcp__'));
  if (mcp.length > 0) {
    const [, server = '', tool = ''] = mcp[0]!.name.split('__');
    parts.push(mcp.length === 1 ? `Used ${tool} from ${server}` : `Used ${String(mcp.length)} tools from ${server}`);
  }
  const other = calls.filter((c) => !known.has(c.name) && !c.name.startsWith('mcp__'));
  if (other.length > 0) parts.push(`Used ${[...new Set(other.map((c) => c.name))].join(', ')}`);

  const denied = calls.filter((c) => c.result?.display?.kind === 'denied').length;
  if (denied > 0) parts.push(plural(denied, 'one action was declined', '# actions were declined'));

  return parts.map((p, i) => (i === 0 ? p.charAt(0).toUpperCase() + p.slice(1) : p.charAt(0).toLowerCase() + p.slice(1))).join(', ');
}

/** The model's own description of a shell command, when it gave one. */
export function shellDescription(call: ToolCall): string | null {
  if (call.name !== 'Shell') return null;
  const description = inputOf<{ description: string }>(call.input).description;
  return typeof description === 'string' && description.trim().length > 0 ? description.trim().replace(/\.$/, '') : null;
}

/** Per-call one-liner in the expanded group. */
export function describeCall(call: ToolCall): string {
  const input = inputOf<Record<string, unknown>>(call.input);
  const str = (key: string): string => {
    const value = input[key];
    return typeof value === 'string' ? value : '';
  };
  const edit = call.result?.display?.kind === 'edit' && !call.result.isError ? call.result.display : null;
  switch (call.name) {
    case 'Read':
      return `Read ${str('file_path')}`;
    case 'Write':
      return `${edit && !edit.created ? 'Rewrote' : edit ? 'Created' : 'Write'} ${str('file_path')}`;
    case 'Edit':
    case 'MultiEdit':
      return `${edit ? 'Edited' : 'Edit'} ${str('file_path')}`;
    case 'Glob':
      return `Find files ${str('pattern')}`;
    case 'Grep':
      return `${call.result ? 'Searched for' : 'Search'} “${str('pattern')}”${str('path') ? ` in ${str('path')}` : ''}`;
    case 'Shell':
      return shellDescription(call) ?? str('command').split('\n')[0] ?? '';
    case 'ShellOutput':
      return `Check background command ${str('shell_id')}`;
    case 'KillShell':
      return `Stop background command ${str('shell_id')}`;
    case 'WebFetch':
      return `${call.result ? 'Read' : 'Reading'} ${str('url')}`;
    case 'WebSearch':
      return `${call.result ? 'Searched' : 'Searching'} the web for “${str('query')}”`;
    case 'Task':
      return `Sub-agent: ${str('description')}`;
    case 'AskUserQuestion':
      return 'Ask a question';
    default:
      return call.name.startsWith('mcp__') ? call.name.split('__').slice(1).join(' · ') : call.name;
  }
}
