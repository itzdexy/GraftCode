import { useMemo } from 'react';
import { SearchResultList } from '../web/SearchResults';
import { CircleCheck, CircleDashed, CircleDot, FileText } from 'lucide-react';
import type { ToolResultBlock } from '@shared/schemas/messages';
import type { TodoItem, ToolDisplay } from '@shared/schemas/toolDisplay';
import { Badge } from '../../components/Badge';
import { cn } from '../../lib/cn';
import { invoke } from '../../lib/ipc';
import { reportError } from '../../stores/toasts';
import { DiffView } from '../diff/DiffView';
import { countChanges, parsePatch } from '../diff/diffModel';
import { CodeBlock } from './CodeBlock';
import { fileSize } from './FilesCard';
import { Markdown } from './Markdown';
import type { ToolCall } from './transcriptModel';

const OUTPUT = 'selectable max-h-[260px] overflow-auto rounded-sm bg-code-block px-10 py-6 font-mono text-[calc(var(--g-code-font-size)-1px)] leading-[1.5] whitespace-pre-wrap text-fg-secondary';

function resultText(result: ToolResultBlock): string {
  return result.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

function revealLog(path: string): void {
  invoke('app:revealPath', { path }).catch((error: unknown) => reportError("Couldn't open the log", error));
}

export function TodoList({ todos, className }: { todos: TodoItem[]; className?: string }) {
  if (todos.length === 0) return <p className="text-sm text-fg-muted">The task list is empty.</p>;
  return (
    <ul className={cn('flex flex-col gap-3', className)} aria-label="Task list">
      {todos.map((todo, i) => (
        <li key={todo.id || i} className="flex items-start gap-8 text-md">
          {todo.status === 'completed' ? (
            <CircleCheck className="mt-2 size-14 shrink-0 text-success" aria-label="Done" />
          ) : todo.status === 'in_progress' ? (
            <CircleDot className="mt-2 size-14 shrink-0 text-blue" aria-label="In progress" />
          ) : (
            <CircleDashed className="mt-2 size-14 shrink-0 text-icon-muted" aria-label="To do" />
          )}
          <span className={cn(todo.status === 'completed' ? 'text-fg-muted line-through decoration-fg-faint' : todo.status === 'in_progress' ? 'text-fg-strong' : 'text-fg-secondary')}>
            {todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content}
          </span>
        </li>
      ))}
    </ul>
  );
}

function DisplayBody({ display, result }: { display: ToolDisplay; result: ToolResultBlock }) {
  switch (display.kind) {
    case 'shell':
      return (
        <div className="flex flex-col gap-6">
          <div className="flex flex-wrap items-center gap-6 text-sm text-fg-muted">
            {display.timedOut ? <Badge tone="warning">Timed out</Badge> : null}
            {display.interrupted ? <Badge tone="warning">Stopped</Badge> : null}
            {display.backgroundId ? <Badge>Background · {display.backgroundId}</Badge> : null}
            {display.exitCode !== null ? <Badge tone={display.exitCode === 0 ? 'neutral' : 'danger'}>Exit {display.exitCode}</Badge> : null}
            <span>{formatDuration(display.durationMs)}</span>
            <span className="truncate" title={display.cwd}>
              in {display.cwd}
            </span>
          </div>
          {display.output ? <pre className={OUTPUT}>{display.output}</pre> : <p className="text-sm text-fg-muted">No output.</p>}
          {display.truncated && display.logPath ? (
            <button type="button" className="self-start text-sm text-link hover:underline" onClick={() => revealLog(display.logPath ?? '')}>
              Output was shortened. Show the full log
            </button>
          ) : null}
        </div>
      );
    case 'shell-output':
      return (
        <div className="flex flex-col gap-6">
          <p className="text-sm text-fg-muted">
            Background command {display.shellId}: {display.status}
            {display.exitCode !== null ? ` (exit ${display.exitCode})` : ''}
          </p>
          {display.output ? <pre className={OUTPUT}>{display.output}</pre> : null}
        </div>
      );
    case 'kill-shell':
      return <p className="text-sm text-fg-muted">{display.killed ? `Stopped ${display.shellId}.` : `${display.shellId} had already finished.`}</p>;
    case 'read':
      return (
        <p className="flex items-center gap-6 text-sm text-fg-muted">
          <FileText className="size-12" aria-hidden="true" />
          {display.image ? 'Image' : `Lines ${display.startLine}–${display.endLine} of ${display.totalLines}`}
        </p>
      );
    case 'edit':
      return <EditDiff patch={display.patch} />;
    case 'glob':
      return (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-fg-muted">
            {display.count} {display.count === 1 ? 'match' : 'matches'} for {display.pattern}
          </p>
          {display.files.length > 0 ? <pre className={OUTPUT}>{display.files.join('\n')}</pre> : null}
        </div>
      );
    case 'grep':
      return (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-fg-muted">
            {display.count} {display.count === 1 ? 'result' : 'results'} for {display.pattern}
          </p>
          {display.preview ? <pre className={OUTPUT}>{display.preview}</pre> : null}
        </div>
      );
    case 'fetch':
      return (
        <p className="text-sm text-fg-muted">
          {display.status} · {Math.round(display.bytes / 1024)} KB{display.title ? ` · ${display.title}` : ''}
        </p>
      );
    case 'todos':
      return <TodoList todos={display.todos} />;
    case 'task':
      return (
        <div className="flex flex-col gap-6">
          <p className="text-sm text-fg-muted">
            {display.toolCalls} tool {display.toolCalls === 1 ? 'call' : 'calls'}
          </p>
          <Markdown text={display.summary} variant="code" />
        </div>
      );
    case 'question':
      return (
        <ul className="flex flex-col gap-4 text-sm">
          {display.answers.map((a, i) => (
            <li key={i}>
              <span className="text-fg-muted">{a.question}</span> <span className="text-fg">{a.answer ?? 'Skipped'}</span>
            </li>
          ))}
        </ul>
      );
    case 'plan':
      return <Markdown text={display.plan} variant="code" />;
    case 'mcp':
      return <pre className={OUTPUT}>{display.text}</pre>;
    case 'web-search':
      return <SearchResultList results={display.results} />;
    case 'file':
      return (
        <div className="flex flex-col gap-6">
          <p className="text-sm text-fg-muted">
            {display.name} · {fileSize(display.size)}
          </p>
          {display.preview ? <pre className={OUTPUT}>{display.preview}</pre> : null}
        </div>
      );
    case 'code':
      return (
        <div className="flex flex-col gap-6">
          <CodeBlock code={display.code} language="javascript" />
          <div className="flex flex-wrap items-center gap-6 text-sm text-fg-muted">
            {display.timedOut ? <Badge tone="warning">Timed out</Badge> : display.error ? <Badge tone="danger">Error</Badge> : null}
            <span>{formatDuration(display.durationMs)} in the sandbox</span>
            {display.files.length > 0 ? <span>· made {display.files.map((f) => f.name).join(', ')}</span> : null}
          </div>
          {display.output ? <pre className={OUTPUT}>{display.output}</pre> : !display.error ? <p className="text-sm text-fg-muted">No output.</p> : null}
          {display.error ? <pre className={cn(OUTPUT, 'text-danger')}>{display.error}</pre> : null}
        </div>
      );
    case 'denied':
      return <p className="text-sm text-fg-muted">Not run: {display.reason}</p>;
    case 'error':
      return <p className="selectable text-sm text-danger">{display.message}</p>;
    case 'text':
      return <pre className={OUTPUT}>{display.text}</pre>;
  }
  return <pre className={OUTPUT}>{resultText(result)}</pre>;
}

export function EditDiff({ patch }: { patch: string }) {
  const rows = useMemo(() => parsePatch(patch), [patch]);
  const { added, removed } = countChanges(rows);
  return (
    <div className="overflow-hidden rounded-sm border border-border-card">
      <div className="flex gap-8 border-b border-border-card bg-sunken px-8 py-2 font-mono text-2xs">
        <span className="text-diff-add">+{added}</span>
        <span className="text-diff-del">-{removed}</span>
      </div>
      <DiffView rows={rows} mode="unified" className="max-h-[320px] overflow-y-auto" />
    </div>
  );
}

/** Body of one tool call in an expanded group: exact command, output, diff, or result text. */
export function ToolCallBody({ call }: { call: ToolCall }) {
  if (call.running) {
    return call.running.output ? <pre className={OUTPUT}>{call.running.output}</pre> : <p className="text-sm text-fg-muted">Running…</p>;
  }
  if (!call.result) return <p className="text-sm text-fg-muted">Waiting to run.</p>;
  if (call.result.display) return <DisplayBody display={call.result.display} result={call.result} />;
  const text = resultText(call.result);
  return text ? <pre className={cn(OUTPUT, call.result.isError && 'text-danger')}>{text}</pre> : <p className="text-sm text-fg-muted">No output.</p>;
}
