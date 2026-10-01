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
  | { kind: 'text'; key: string; messageId: string; text: string; live: boolean; endOfTurn: boolean }
  | { kind: 'thinking'; key: string; text: string; live: boolean; progress: boolean }
  | { kind: 'tools'; key: string; calls: ToolCall[] }
  | { kind: 'todos'; key: string; callId: string; todos: TodoItem[]; latest: boolean }
  | { kind: 'plan'; key: string; callId: string; plan: string; display: Extract<ToolDisplay, { kind: 'plan' }> | null }
  | { kind: 'provider'; key: string; summary: string }
  | { kind: 'compaction'; key: string; text: string }
  | { kind: 'command-output'; key: string; text: string }
  | { kind: 'notice'; key: string; text: string }
  | { kind: 'error'; key: string; messageId: string; code: string; message: string }
  | { kind: 'interrupted'; key: string };

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
  let turn = 0;

  const flush = (): void => {
    if (group && group.length > 0) items.push({ kind: 'tools', key: groupKey, calls: group });
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
            items.push({ kind: 'text', key, messageId: message.id, text: block.text, live: false, endOfTurn: false });
          }
          break;
        case 'thinking':
          if (block.text.trim().length > 0) {
            flush();
            items.push({ kind: 'thinking', key, text: block.text, live: false, progress: block.display === 'update' });
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
            group.push(call);
          }
          break;
        }
        case 'provider':
          // Reasoning kept only for the provider's next request has no summary and stays hidden.
          if (block.summary.length > 0) {
            flush();
            items.push({ kind: 'provider', key, summary: block.summary });
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
    if (s.thinking.trim().length > 0) items.push({ kind: 'thinking', key: `${s.messageId}:live-thinking`, text: s.thinking, live: true, progress: false });
    if (s.text.length > 0) items.push({ kind: 'text', key: `${s.messageId}:live`, messageId: s.messageId, text: s.text, live: true, endOfTurn: false });
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

/** One muted line for a group of tool calls, e.g. "Read 2 files, ran 4 commands (1 failed)". */
export function summarizeCalls(calls: ToolCall[]): string {
  if (calls.length === 1) {
    const only = calls[0]!;
    const description = inputOf<{ description: string }>(only.input).description;
    if (only.name === 'Shell' && typeof description === 'string' && description.trim().length > 0 && !commandFailed(only)) {
      const d = description.trim().replace(/\.$/, '');
      return d.charAt(0).toUpperCase() + d.slice(1);
    }
  }
  const parts: string[] = [];
  const byName = (names: string[]): ToolCall[] => calls.filter((c) => names.includes(c.name));

  const reads = byName(['Read']);
  if (reads.length > 0) {
    const paths = new Set(reads.map((c) => String(inputOf<{ file_path: string }>(c.input).file_path ?? '')));
    parts.push(paths.size === 1 ? `Read ${fileName([...paths][0] ?? '')}` : `Read ${paths.size} files`);
  }
  const allWrites = byName(['Write', 'Edit', 'MultiEdit']);
  if (allWrites.length > 0) {
    // Failed edits changed nothing, so they never count as "Edited".
    const declined = (c: ToolCall): boolean => c.result?.display?.kind === 'denied';
    const failed = allWrites.filter((c) => c.result?.isError === true && !declined(c));
    const writes = allWrites.filter((c) => c.result?.isError !== true && !declined(c));
    const pathsOf = (list: ToolCall[]): Set<string> => new Set(list.map((c) => String(inputOf<{ file_path: string }>(c.input).file_path ?? '')));
    if (writes.length > 0) {
      const created = writes.filter((c) => c.result?.display?.kind === 'edit' && c.result.display.created);
      const paths = pathsOf(writes);
      const verb = created.length === writes.length ? 'Created' : 'Edited';
      parts.push(paths.size === 1 ? `${verb} ${fileName([...paths][0] ?? '')}` : `${verb} ${paths.size} files`);
    }
    if (failed.length > 0) {
      const paths = pathsOf(failed);
      parts.push(paths.size === 1 ? `couldn't edit ${fileName([...paths][0] ?? '')}` : `couldn't edit ${paths.size} files`);
    }
  }
  const globs = byName(['Glob']);
  if (globs.length > 0) parts.push(plural(globs.length, 'Listed files', 'Listed files # times'));
  const greps = byName(['Grep']);
  if (greps.length > 0) {
    const pattern = String(inputOf<{ pattern: string }>(greps[0]!.input).pattern ?? '');
    parts.push(greps.length === 1 ? `Searched for “${pattern.length > 40 ? `${pattern.slice(0, 39)}…` : pattern}”` : `Ran ${greps.length} searches`);
  }
  const commands = byName(['Shell']);
  if (commands.length > 0) {
    const failed = commands.filter(commandFailed).length;
    const background = commands.filter((c) => c.result?.display?.kind === 'shell' && c.result.display.backgroundId !== null).length;
    let phrase = plural(commands.length, 'Ran a command', 'Ran # commands');
    if (failed > 0) phrase += ` (${failed} failed)`;
    if (background > 0) phrase += `, ${plural(background, 'started one in the background', 'started # in the background')}`;
    parts.push(phrase);
  }
  const checks = byName(['ShellOutput']);
  if (checks.length > 0) {
    const finished = checks.filter((c) => c.result?.display?.kind === 'shell-output' && c.result.display.status !== 'running').length;
    parts.push(finished > 0 ? plural(finished, 'Finished a background command', 'Finished # background commands') : 'Checked a background command');
  }
  const kills = byName(['KillShell']);
  if (kills.length > 0) parts.push(plural(kills.length, 'Stopped a background command', 'Stopped # background commands'));
  const fetches = byName(['WebFetch']);
  if (fetches.length > 0) {
    let host: string;
    try {
      host = new URL(String(inputOf<{ url: string }>(fetches[0]!.input).url ?? '')).hostname;
    } catch {
      host = 'a page';
    }
    parts.push(fetches.length === 1 ? `Fetched ${host}` : `Fetched ${fetches.length} pages`);
  }
  const tasks = byName(['Task']);
  if (tasks.length > 0) {
    const description = String(inputOf<{ description: string }>(tasks[0]!.input).description ?? '');
    parts.push(tasks.length === 1 ? `Delegated: ${description}` : `Ran ${tasks.length} sub-agents`);
  }
  const questions = byName(['AskUserQuestion']);
  if (questions.length > 0) parts.push('Asked you a question');
  const known = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'Shell', 'ShellOutput', 'KillShell', 'WebFetch', 'Task', 'AskUserQuestion']);
  const mcp = calls.filter((c) => c.name.startsWith('mcp__'));
  if (mcp.length > 0) {
    const [, server = '', tool = ''] = mcp[0]!.name.split('__');
    parts.push(mcp.length === 1 ? `Used ${tool} from ${server}` : `Used ${mcp.length} tools from ${server}`);
  }
  const other = calls.filter((c) => !known.has(c.name) && !c.name.startsWith('mcp__'));
  if (other.length > 0) parts.push(`Used ${[...new Set(other.map((c) => c.name))].join(', ')}`);

  const denied = calls.filter((c) => c.result?.display?.kind === 'denied').length;
  if (denied > 0) parts.push(plural(denied, 'one action was declined', '# actions were declined'));

  return parts.map((p, i) => (i === 0 ? p.charAt(0).toUpperCase() + p.slice(1) : p.charAt(0).toLowerCase() + p.slice(1))).join(', ');
}

/** Per-call one-liner in the expanded group. */
export function describeCall(call: ToolCall): string {
  const input = inputOf<Record<string, unknown>>(call.input);
  const str = (key: string): string => {
    const value = input[key];
    return typeof value === 'string' ? value : '';
  };
  switch (call.name) {
    case 'Read':
      return `Read ${str('file_path')}`;
    case 'Write':
      return `Write ${str('file_path')}`;
    case 'Edit':
    case 'MultiEdit':
      return `Edit ${str('file_path')}`;
    case 'Glob':
      return `Find files ${str('pattern')}`;
    case 'Grep':
      return `Search ${str('pattern')}${str('path') ? ` in ${str('path')}` : ''}`;
    case 'Shell':
      return str('command').split('\n')[0] ?? '';
    case 'ShellOutput':
      return `Check background command ${str('shell_id')}`;
    case 'KillShell':
      return `Stop background command ${str('shell_id')}`;
    case 'WebFetch':
      return `Fetch ${str('url')}`;
    case 'Task':
      return `Sub-agent: ${str('description')}`;
    case 'AskUserQuestion':
      return 'Ask a question';
    default:
      return call.name.startsWith('mcp__') ? call.name.split('__').slice(1).join(' · ') : call.name;
  }
}
