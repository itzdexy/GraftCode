import type { CheckReport, ImageBlock, StoredMessage, ToolResultBlock, UserShell } from '@shared/schemas/messages';
import type { MadeFile, MediaFile, TodoItem, ToolDisplay } from '@shared/schemas/toolDisplay';

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
  /** `closing`: the model ended its step with this text (no tool call came with it), so it reads as an answer unless more work follows. */
  | { kind: 'text'; key: string; messageId: string; text: string; live: boolean; closing: boolean; endOfTurn: boolean; at: number }
  | { kind: 'thinking'; key: string; text: string; live: boolean; progress: boolean; at: number }
  | { kind: 'tools'; key: string; calls: ToolCall[]; at: number }
  | { kind: 'todos'; key: string; callId: string; todos: TodoItem[]; latest: boolean }
  | { kind: 'plan'; key: string; callId: string; plan: string; display: Extract<ToolDisplay, { kind: 'plan' }> | null }
  | { kind: 'provider'; key: string; summary: string; at: number; search: SearchInfo | null }
  | { kind: 'compaction'; key: string; text: string }
  | { kind: 'command-output'; key: string; text: string }
  | { kind: 'shell'; key: string; shell: UserShell }
  | { kind: 'check'; key: string; check: CheckReport }
  /** Where a later turn of a mission starts: which turn, of how many, and whether it follows checks that failed. */
  | { kind: 'mission'; key: string; turn: number; of: number; afterChecks: boolean; at: number }
  | { kind: 'notice'; key: string; text: string }
  | { kind: 'error'; key: string; messageId: string; code: string; message: string }
  | { kind: 'interrupted'; key: string }
  | { kind: 'edits'; key: string; files: EditedFile[] }
  | { kind: 'files'; key: string; files: MadeFile[] }
  | { kind: 'media'; key: string; media: MadeMedia }
  | ActivityItem;

/** A file a turn changed, with its line counts and the patches that did it. */
export interface EditedFile {
  path: string;
  added: number;
  removed: number;
  created: boolean;
  patches: string[];
}

/** The pictures and clips a turn generated, with the engine that made the newest of them. */
export interface MadeMedia {
  engine: string;
  model: string;
  /** What the turn's pictures cost together; null when a provider didn't say. */
  costUsd: number | null;
  files: MediaFile[];
}

export interface SearchInfo {
  query: string;
  /** `site` names the site when the URL is a redirect. */
  results: Array<{ title: string; url: string; site?: string }>;
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
    if (kind === 'shell') {
      flush();
      if (message.meta.shell) items.push({ kind: 'shell', key: message.id, shell: message.meta.shell });
      continue;
    }
    if (kind === 'check') {
      flush();
      if (message.meta.check) items.push({ kind: 'check', key: message.id, check: message.meta.check });
      continue;
    }
    if (kind === 'mission') {
      flush();
      const at = message.meta.mission;
      items.push({ kind: 'mission', key: message.id, turn: at?.turn ?? 0, of: at?.of ?? 0, afterChecks: at?.afterChecks ?? false, at: message.createdAt });
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

    // A message's first text and first thought keep the key they had while streaming (see the
    // live items below), so the reply stays in place when it is stored instead of arriving again.
    const firstText = message.content.findIndex((b) => b.type === 'text');
    const firstThinking = message.content.findIndex((b) => b.type === 'thinking');
    const closing = !message.content.some((b) => b.type === 'tool_use');
    message.content.forEach((block, index) => {
      const key = index === firstText ? `${message.id}:text` : index === firstThinking ? `${message.id}:thinking` : `${message.id}:${index}`;
      switch (block.type) {
        case 'text':
          if (block.text.trim().length > 0) {
            flush();
            items.push({ kind: 'text', key, messageId: message.id, text: block.text, live: false, closing, endOfTurn: false, at: message.createdAt });
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
    if (s.thinking.trim().length > 0) items.push({ kind: 'thinking', key: `${s.messageId}:thinking`, text: s.thinking, live: true, progress: false, at });
    if (s.text.length > 0) items.push({ kind: 'text', key: `${s.messageId}:text`, messageId: s.messageId, text: s.text, live: true, closing: false, endOfTurn: false, at });
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
    // A "!" command stands apart from the turn before it, so that turn's file card stays with it.
    // A later turn of a mission is a turn of its own: it gets its own answer and its own file card.
    if (item.kind === 'user' || item.kind === 'shell' || item.kind === 'mission') turns.push([item]);
    else turns.at(-1)?.push(item);
  }
  turns.forEach((segment, index) => {
    const lastTurn = index === turns.length - 1;
    const turnStart = out.length;
    const first = segment[0];
    const startedAt = first?.kind === 'user' ? first.message.createdAt : first?.kind === 'mission' ? first.at : null;
    // The answer: the last text with no work after it. While the turn runs, that is the text
    // streaming now, or a stored one the model ended its step with (it stays the answer while
    // hooks and checks run, and becomes narration if the turn goes on working).
    let answer = -1;
    for (let i = segment.length - 1; i >= 0; i--) {
      const item = segment[i];
      if (!item || !isWork(item)) continue;
      if (item.kind === 'text' && (item.live || item.closing || !(lastTurn && turnActive))) answer = i;
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
    // A finished turn ends with the files it changed.
    const running = lastTurn && turnActive;
    if (!running) {
      const calls = segment.flatMap((item) => (item.kind === 'tools' ? item.calls : []));
      const files = editedFiles(calls);
      if (files.length > 0) out.push({ kind: 'edits', key: `edits:${segment[0]?.key ?? String(index)}`, files });
      // …and, in chats, the files it made for the user to download.
      const made = madeFiles(calls);
      if (made.length > 0) out.push({ kind: 'files', key: `files:${segment[0]?.key ?? String(index)}`, files: made });
      const media = madeMedia(calls);
      if (media) out.push({ kind: 'media', key: `media:${segment[0]?.key ?? String(index)}`, media });
    }
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

/** Files changed by edits that went through, in the order they were first changed. */
export function editedFiles(calls: ToolCall[]): EditedFile[] {
  const byPath = new Map<string, EditedFile>();
  for (const call of calls) {
    const d = call.result?.display;
    if (d?.kind !== 'edit' || call.result?.isError) continue;
    const file = byPath.get(d.path) ?? { path: d.path, added: 0, removed: 0, created: false, patches: [] };
    file.added += d.added;
    file.removed += d.removed;
    file.created ||= d.created;
    if (d.patch) file.patches.push(d.patch);
    byPath.set(d.path, file);
  }
  return [...byPath.values()];
}

/** Files a chat's CreateFile and RunCode calls made, in order. */
export function madeFiles(calls: ToolCall[]): MadeFile[] {
  return calls.flatMap((call) => {
    const d = call.result?.display;
    if (d?.kind === 'file') return [{ name: d.name, size: d.size, mime: d.mime }];
    return d?.kind === 'code' ? d.files : [];
  });
}

/** Pictures and clips generated by GenerateImage and ComfyUI calls, in order; null when there are none. */
export function madeMedia(calls: ToolCall[]): MadeMedia | null {
  const made = calls.flatMap((call) => (call.result?.display?.kind === 'media' && !call.result.isError ? [call.result.display] : []));
  const last = made.at(-1);
  if (!last) return null;
  const known = made.every((m) => m.costUsd !== null);
  return { engine: last.engine, model: last.model, costUsd: known ? made.reduce((sum, m) => sum + (m.costUsd ?? 0), 0) : null, files: made.flatMap((m) => m.files) };
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
  if (calls.length > 0) parts.push(summarizeCalls(calls, 3));
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

/** How many agents a RunAgents call asked for. */
function agentCount(input: unknown): number {
  const agents = inputOf<{ agents: unknown }>(input).agents;
  return Array.isArray(agents) ? agents.length : 0;
}

/**
 * One muted line for a group of tool calls, most telling first:
 * "Ran 4 commands (1 failed), created a.ts, edited 2 files, read b.ts".
 */
export function summarizeCalls(calls: ToolCall[], limit = Number.POSITIVE_INFINITY): string {
  if (calls.length === 1) {
    const only = calls[0]!;
    const description = shellDescription(only);
    if (description && !commandFailed(only)) return description.charAt(0).toUpperCase() + description.slice(1);
  }
  const all = summaryParts(calls);
  const kept = all.slice(0, limit);
  const rest = all.slice(kept.length).reduce((n, part) => n + part.calls, 0);
  const phrases = kept.map((part) => part.text);
  if (rest > 0) phrases.push(`and ${String(rest)} more ${rest === 1 ? 'action' : 'actions'}`);
  return phrases.map((p, i) => (i === 0 ? p.charAt(0).toUpperCase() + p.slice(1) : p.charAt(0).toLowerCase() + p.slice(1))).join(', ');
}

/** The phrases of a summary, each with how many calls it stands for. */
function summaryParts(calls: ToolCall[]): Array<{ text: string; calls: number }> {
  const parts: Array<{ text: string; calls: number }> = [];
  const push = (text: string, count: number): void => {
    parts.push({ text, calls: count });
  };
  const byName = (names: string[]): ToolCall[] => calls.filter((c) => names.includes(c.name));
  const noted = byName(['MissionUpdate']);
  // A group of agents is the largest piece of work a block can hold, so it leads.
  const groups = byName(['RunAgents']);
  if (groups.length > 0) push(groups.length === 1 ? plural(agentCount(groups[0]!.input), 'Ran an agent', 'Ran # agents') : `Ran ${String(groups.length)} groups of agents`, groups.length);
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
    push(phrase, commands.length);
  }
  const allWrites = byName(['Write', 'Edit', 'MultiEdit']);
  if (allWrites.length > 0) {
    // Failed edits changed nothing, so they never count as edited.
    const declined = (c: ToolCall): boolean => c.result?.display?.kind === 'denied';
    const failed = allWrites.filter((c) => c.result?.isError === true && !declined(c));
    const writes = allWrites.filter((c) => c.result?.isError !== true && !declined(c));
    const created = writes.filter((c) => c.result?.display?.kind === 'edit' && c.result.display.created);
    const edited = writes.filter((c) => !created.includes(c));
    if (created.length > 0) push(files('Created', created), created.length);
    if (edited.length > 0) push(files('Edited', edited), edited.length);
    if (failed.length > 0) push(files("couldn't edit", failed), failed.length);
  }
  const reads = byName(['Read']);
  if (reads.length > 0) push(files('Read', reads), reads.length);
  const greps = byName(['Grep']);
  if (greps.length > 0) {
    const pattern = String(inputOf<{ pattern: string }>(greps[0]!.input).pattern ?? '');
    push(greps.length === 1 ? `Searched for “${pattern.length > 40 ? `${pattern.slice(0, 39)}…` : pattern}”` : `Ran ${String(greps.length)} searches`, greps.length);
  }
  const globs = byName(['Glob']);
  if (globs.length > 0) push(plural(globs.length, 'Listed files', 'Listed files # times'), globs.length);
  const checks = byName(['ShellOutput']);
  if (checks.length > 0) {
    const finished = checks.filter((c) => c.result?.display?.kind === 'shell-output' && c.result.display.status !== 'running').length;
    push(finished > 0 ? plural(finished, 'Finished a background command', 'Finished # background commands') : 'Checked a background command', checks.length);
  }
  const kills = byName(['KillShell']);
  if (kills.length > 0) push(plural(kills.length, 'Stopped a background command', 'Stopped # background commands'), kills.length);
  const searches = byName(['WebSearch']);
  if (searches.length > 0) push(searchedPhrase(searches.map(searchOfCall)), searches.length);
  const computer = byName(['Computer']);
  if (computer.length > 0) push(plural(computer.length, 'Used the computer once', 'Used the computer # times'), computer.length);
  const browsing = byName(['Browser']);
  if (browsing.length > 0) {
    const opened = browsing.find((c) => inputOf<{ action: string }>(c.input).action === 'open');
    const host = opened ? hostOf(String(inputOf<{ url: string }>(opened.input).url ?? '')) : null;
    push(host ? `Tested ${host} in the browser` : plural(browsing.length, 'Used the browser', 'Used the browser # times'), browsing.length);
  }
  const fetches = byName(['WebFetch']);
  if (fetches.length > 0) {
    let host: string;
    try {
      host = new URL(String(inputOf<{ url: string }>(fetches[0]!.input).url ?? '')).hostname;
    } catch {
      host = 'a page';
    }
    push(fetches.length === 1 ? `Fetched ${host}` : `Fetched ${String(fetches.length)} pages`, fetches.length);
  }
  const tasks = byName(['Task']);
  if (tasks.length > 0) {
    const description = String(inputOf<{ description: string }>(tasks[0]!.input).description ?? '');
    push(tasks.length === 1 ? `Delegated: ${description}` : `Ran ${String(tasks.length)} sub-agents`, tasks.length);
  }
  const made = byName(['CreateFile']).filter((c) => c.result?.display?.kind === 'file');
  if (made.length > 0) {
    const names = made.map((c) => (c.result?.display?.kind === 'file' ? c.result.display.name : ''));
    push(names.length === 1 ? `Created ${names[0] ?? ''}` : `Created ${String(names.length)} files`, made.length);
  }
  const runs = byName(['RunCode']);
  if (runs.length > 0) push(plural(runs.length, 'Ran code', 'Ran code # times'), runs.length);
  const images = byName(['GenerateImage']);
  if (images.length > 0) push(plural(images.length, 'Generated an image', 'Generated # images'), images.length);
  const comfy = byName(['ComfyUI']);
  if (comfy.length > 0) {
    const runs = comfy.filter((c) => inputOf<{ action: string }>(c.input).action === 'run').length;
    push(runs > 0 ? plural(runs, 'Ran a ComfyUI workflow', 'Ran # ComfyUI workflows') : 'Checked ComfyUI', comfy.length);
  }
  const questions = byName(['AskUserQuestion']);
  if (questions.length > 0) push('Asked you a question', questions.length);
  const lookups = byName(['Symbols']);
  if (lookups.length > 0) push(plural(lookups.length, 'Looked up the code’s structure', 'Looked up the code’s structure # times'), lookups.length);
  const finds = byName(['ToolSearch']);
  if (finds.length > 0) push(plural(finds.length, 'Looked for a tool', 'Looked for tools # times'), finds.length);
  const resources = byName(['mcp__resources__list', 'mcp__resources__read']);
  if (resources.length > 0) push(plural(resources.length, 'Looked at an MCP resource', 'Looked at # MCP resources'), resources.length);
  if (noted.length > 0) {
    const status = noted.map((c) => inputOf<{ status: string }>(c.input).status).find((s) => s === 'done' || s === 'blocked');
    push(status === 'done' ? 'Reported the mission done' : status === 'blocked' ? 'Paused the mission' : plural(noted.length, 'Noted something for the mission', 'Noted # things for the mission'), noted.length);
  }
  const known = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'Shell', 'ShellOutput', 'KillShell', 'WebFetch', 'WebSearch', 'Computer', 'Browser', 'Task', 'RunAgents', 'MissionUpdate', 'Symbols', 'ToolSearch', 'AskUserQuestion', 'CreateFile', 'RunCode', 'GenerateImage', 'ComfyUI']);
  const mcp = calls.filter((c) => c.name.startsWith('mcp__') && !c.name.startsWith('mcp__resources__'));
  if (mcp.length > 0) {
    const [, server = '', tool = ''] = mcp[0]!.name.split('__');
    push(mcp.length === 1 ? `Used ${tool} from ${server}` : `Used ${String(mcp.length)} tools from ${server}`, mcp.length);
  }
  const other = calls.filter((c) => !known.has(c.name) && !c.name.startsWith('mcp__'));
  if (other.length > 0) push(`Used ${[...new Set(other.map((c) => c.name))].join(', ')}`, other.length);

  const denied = calls.filter((c) => c.result?.display?.kind === 'denied').length;
  if (denied > 0) push(plural(denied, 'one action was declined', '# actions were declined'), 0);
  return parts;
}

/** A row's wording: the action in muted text, then what it acted on in strong text (paths shortened to file names). */
export function callParts(call: ToolCall): { verb: string; target: string; mono: boolean; title: string } {
  const input = inputOf<Record<string, unknown>>(call.input);
  const str = (key: string): string => {
    const value = input[key];
    return typeof value === 'string' ? value : '';
  };
  const done = call.result !== null;
  const edit = call.result?.display?.kind === 'edit' && !call.result.isError ? call.result.display : null;
  const path = str('file_path');
  switch (call.name) {
    case 'Read':
      return { verb: done ? 'Read' : 'Reading', target: fileName(path), mono: false, title: path };
    case 'Write':
      return { verb: edit && !edit.created ? 'Rewrote' : edit ? 'Created' : 'Writing', target: fileName(path), mono: false, title: path };
    case 'Edit':
    case 'MultiEdit':
      return { verb: edit ? 'Edited' : 'Editing', target: fileName(path), mono: false, title: path };
    case 'Grep':
      return { verb: done ? 'Searched for' : 'Searching for', target: `“${str('pattern')}”`, mono: false, title: str('path') || str('pattern') };
    case 'Glob':
      return { verb: done ? 'Listed' : 'Listing', target: str('pattern'), mono: false, title: str('pattern') };
    case 'Shell': {
      const description = shellDescription(call);
      const command = str('command').split('\n')[0] ?? '';
      return description ? { verb: description, target: '', mono: false, title: command } : { verb: '', target: command, mono: true, title: command };
    }
    case 'WebFetch': {
      const url = str('url');
      let shown = url;
      try {
        const u = new URL(url);
        shown = `${u.hostname.replace(/^www\./, '')}${u.pathname === '/' ? '' : u.pathname}`;
      } catch {
        // Keep the raw string; the schema already checked it is a URL.
      }
      return { verb: done ? 'Read' : 'Reading', target: shown, mono: false, title: url };
    }
    case 'Task':
      return { verb: 'Sub-agent', target: str('description'), mono: false, title: str('prompt') };
    case 'RunAgents':
      return { verb: plural(agentCount(call.input), done ? 'Ran an agent' : 'Running an agent', done ? 'Ran # agents' : 'Running # agents'), target: str('goal'), mono: false, title: str('goal') };
    case 'Symbols': {
      const action = str('action');
      const file = fileName(str('path'));
      if (action === 'outline') return { verb: done ? 'Outlined' : 'Outlining', target: file, mono: false, title: str('path') };
      if (action === 'importers') return { verb: done ? 'Found what imports' : 'Finding what imports', target: file, mono: false, title: str('path') };
      if (action === 'tests') return { verb: done ? 'Found the tests of' : 'Finding the tests of', target: file, mono: false, title: str('path') };
      const what = action === 'definition' ? 'the definition of' : 'uses of';
      return { verb: done ? `Found ${what}` : `Finding ${what}`, target: str('name'), mono: true, title: str('name') };
    }
    case 'ToolSearch':
      return { verb: done ? 'Searched tools for' : 'Searching tools for', target: `“${str('query')}”`, mono: false, title: str('query') };
    case 'mcp__resources__list':
      return { verb: done ? 'Listed MCP resources' : 'Listing MCP resources', target: str('server'), mono: false, title: 'MCP resources' };
    case 'mcp__resources__read':
      return { verb: done ? 'Read' : 'Reading', target: str('uri'), mono: true, title: `${str('server')}: ${str('uri')}` };
    case 'MissionUpdate': {
      const status = str('status');
      if (status === 'done') return { verb: 'Reported the mission done', target: '', mono: false, title: str('summary') };
      if (status === 'blocked') return { verb: 'Paused the mission', target: str('summary'), mono: false, title: str('summary') };
      const note = inputOf<{ kind: string; text: string }>(input.note);
      const kind = typeof note.kind === 'string' ? note.kind : '';
      const text = typeof note.text === 'string' ? note.text : '';
      return { verb: kind === 'progress' ? 'Noted progress' : kind ? `Noted a ${kind}` : 'Noted', target: text, mono: false, title: text };
    }
    case 'CreateFile': {
      const d = call.result?.display;
      const name = d?.kind === 'file' ? d.name : str('name');
      return { verb: d?.kind === 'file' ? 'Created' : done ? "Couldn't create" : 'Creating', target: name, mono: false, title: name };
    }
    case 'RunCode': {
      const d = call.result?.display;
      const verb = !done ? 'Running code' : d?.kind === 'code' && d.error === null ? 'Ran code' : 'Ran code (failed)';
      return { verb, target: '', mono: false, title: 'JavaScript in the sandbox' };
    }
    case 'GenerateImage':
      return { verb: !done ? 'Generating' : call.result?.isError ? "Couldn't generate" : 'Generated', target: fileName(str('path')), mono: false, title: str('prompt') };
    case 'ComfyUI': {
      const action = str('action');
      if (action === 'run') return { verb: done ? 'Ran in ComfyUI' : 'Running in ComfyUI', target: str('workflow') || 'a workflow', mono: false, title: str('prompt') };
      return { verb: action === 'status' ? (done ? 'Checked ComfyUI' : 'Checking ComfyUI') : done ? 'Looked in ComfyUI' : 'Looking in ComfyUI', target: str('name') || str('search') || str('folder'), mono: false, title: 'ComfyUI' };
    }
    case 'Computer': {
      const d = call.result?.display;
      return { verb: d?.kind === 'computer' ? d.summary : d?.kind === 'text' ? d.text : computerVerb(str('action')), target: '', mono: false, title: 'Computer' };
    }
    case 'Browser': {
      const action = str('action');
      const d = call.result?.display;
      const target = action === 'open' ? (hostOf(str('url')) ?? str('url')) : d?.kind === 'browser' && d.title ? d.title : '';
      return { verb: browserVerb(action, done), target, mono: false, title: d?.kind === 'browser' ? d.url : str('url') };
    }
    default:
      return { verb: describeCall(call), target: '', mono: false, title: call.name };
  }
}

/** Host and port of an address, for short labels ("localhost:5173"); null when it isn't one. */
function hostOf(url: string): string | null {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`);
    return u.host.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** What a Browser call did, or is doing. */
function browserVerb(action: string, done: boolean): string {
  const verbs: Record<string, [string, string]> = {
    open: ['Opening', 'Opened'],
    read: ['Reading the page', 'Read the page'],
    screenshot: ['Taking a screenshot', 'Took a screenshot'],
    click: ['Clicking', 'Clicked'],
    type: ['Typing', 'Typed'],
    press: ['Pressing a key', 'Pressed a key'],
    scroll: ['Scrolling', 'Scrolled'],
    wait: ['Waiting for the page', 'Waited for the page'],
    back: ['Going back', 'Went back'],
    reload: ['Reloading', 'Reloaded'],
    console: ['Reading the console', 'Read the console']
  };
  const pair = verbs[action] ?? ['Using the browser', 'Used the browser'];
  return done ? pair[1] : pair[0];
}

/** A computer action before its result names it. */
function computerVerb(action: string): string {
  const verbs: Record<string, string> = {
    screenshot: 'Taking a screenshot',
    click: 'Clicking',
    double_click: 'Double-clicking',
    right_click: 'Right-clicking',
    move: 'Moving the pointer',
    zoom: 'Looking closer',
    open: 'Opening an app',
    drag: 'Dragging',
    scroll: 'Scrolling',
    type: 'Typing',
    key: 'Pressing keys',
    wait: 'Waiting'
  };
  return verbs[action] ?? 'Using the computer';
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
    case 'Browser':
      return `${browserVerb(str('action'), call.result !== null)}${str('url') ? ` ${str('url')}` : ''}`;
    case 'WebSearch':
      return `${call.result ? 'Searched' : 'Searching'} the web for “${str('query')}”`;
    case 'Task':
      return `Sub-agent: ${str('description')}`;
    case 'RunAgents':
      return `${plural(agentCount(call.input), call.result ? 'Ran an agent' : 'Running an agent', call.result ? 'Ran # agents' : 'Running # agents')}: ${str('goal')}`;
    case 'MissionUpdate':
      return str('status') === 'done' ? 'Reported the mission done' : str('status') === 'blocked' ? 'Paused the mission' : 'Noted something for the mission';
    case 'Symbols':
      return `${call.result ? 'Looked up' : 'Looking up'} ${str('name') || str('path')} in the code`;
    case 'ToolSearch':
      return `${call.result ? 'Searched' : 'Searching'} tools for “${str('query')}”`;
    case 'mcp__resources__list':
      return `${call.result ? 'Listed' : 'Listing'} MCP resources${str('server') ? ` of ${str('server')}` : ''}`;
    case 'mcp__resources__read':
      return `${call.result ? 'Read' : 'Reading'} ${str('uri')} from ${str('server')}`;
    case 'AskUserQuestion':
      return 'Ask a question';
    case 'GenerateImage':
      return `${call.result ? 'Generated' : 'Generating'} ${str('path')}`;
    case 'ComfyUI':
      return str('action') === 'run' ? `${call.result ? 'Ran' : 'Running'} ${str('workflow') || 'a workflow'} in ComfyUI` : 'Checked ComfyUI';
    default:
      return call.name.startsWith('mcp__') ? call.name.split('__').slice(1).join(' · ') : call.name;
  }
}
