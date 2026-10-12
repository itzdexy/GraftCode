import { useContext, useMemo, useState } from 'react';
import { SearchResultList } from '../web/SearchResults';
import { CircleCheck, CircleDashed, CircleDot, Copy, FileText, FolderOpen } from 'lucide-react';
import type { ToolResultBlock } from '@shared/schemas/messages';
import type { TodoItem, ToolDisplay } from '@shared/schemas/toolDisplay';
import { Badge } from '../../components/Badge';
import { IconButton } from '../../components/Button';
import { cn } from '../../lib/cn';
import { formatDuration } from '../../lib/format';
import { languageForPath } from '../../lib/highlight';
import { invoke } from '../../lib/ipc';
import { useLoad } from '../../lib/useLoad';
import { useNav } from '../../stores/nav';
import { usePanels } from '../../stores/panels';
import { reportError } from '../../stores/toasts';
import { DiffView } from '../diff/DiffView';
import { countChanges, coveredRows, parsePatch } from '../diff/diffModel';
import { useDiffComments } from '../review/useDiffComments';
import { CodeBlock } from './CodeBlock';
import { ConversationContext } from './conversation';
import { AGENT_STATUS_LABEL, AgentStatusGlyph, isAgentStatus } from '../panels/AgentStatus';
import { FileMenu, useFileActions } from '../panels/FileMenu';
import { fileSize } from './FilesCard';
import { Markdown } from './Markdown';
import { Output, SecretsToggle } from './Output';
import { todoKey } from './todoMotion';
import type { ToolCall } from './transcriptModel';

/** The command a step ran, in full: its row shows the first line only, with any key in it covered. */
const COMMAND = 'selectable max-h-[120px] overflow-auto rounded-sm bg-code-block px-10 py-6 font-mono text-[calc(var(--g-code-font-size)-1px)] leading-[1.5] break-words whitespace-pre-wrap text-fg';
const OUTPUT = 'selectable max-h-[260px] overflow-auto rounded-sm bg-code-block px-10 py-6 font-mono text-[calc(var(--g-code-font-size)-1px)] leading-[1.5] whitespace-pre-wrap text-fg-secondary';

function resultText(result: ToolResultBlock): string {
  return result.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/** Opens the Agents panel of the session on screen (a transcript is only ever shown for that one). */
function showAgents(): void {
  const route = useNav.getState().route;
  if (route.name === 'session') usePanels.getState().show(route.id, 'agents');
}

function revealLog(path: string): void {
  invoke('app:revealPath', { path }).catch((error: unknown) => reportError("Couldn't open the log", error));
}

/**
 * A task list. `changed` names the tasks whose state differs from the list before (see todoMotion.ts): their marks
 * pop in when the list arrives while its turn runs, so a task that was just finished shows it.
 */
export function TodoList({ todos, changed, className }: { todos: TodoItem[]; changed?: readonly string[]; className?: string }) {
  if (todos.length === 0) return <p className="text-sm text-fg-muted">The task list is empty.</p>;
  return (
    <ul className={cn('flex flex-col gap-3', className)} aria-label="Task list">
      {todos.map((todo, i) => {
        const mark = cn('mt-2 size-14 shrink-0', changed?.includes(todoKey(todo, i)) && 'todo-mark--changed');
        return (
        <li key={todo.id || i} className="flex items-start gap-8 text-md">
          {todo.status === 'completed' ? (
            <CircleCheck className={cn(mark, 'text-success')} aria-label="Done" />
          ) : todo.status === 'in_progress' ? (
            <CircleDot className={cn(mark, 'text-blue')} aria-label="In progress" />
          ) : (
            <CircleDashed className={cn(mark, 'text-icon-muted')} aria-label="To do" />
          )}
          <span className={cn(todo.status === 'completed' ? 'text-fg-muted line-through decoration-fg-faint' : todo.status === 'in_progress' ? 'text-fg-strong' : 'text-fg-secondary')}>
            {todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content}
          </span>
        </li>
        );
      })}
    </ul>
  );
}

/**
 * A picture the agent read: shown from what the model was sent, or, for a
 * model that can't see pictures, loaded from the session's folder. Its path
 * can be copied and its folder opened from here.
 */
function ReadImage({ path, result }: { path: string; result: ToolResultBlock }) {
  const sessionId = useNav((s) => (s.route.name === 'session' ? s.route.id : null));
  const run = useFileActions(sessionId ?? '');
  const sent = result.content.find((b) => b.type === 'image');
  // Paths outside the session's folder are shown as "~/…" or in full; only a path inside it can be loaded and acted on.
  const inside = sessionId !== null && !/^(~|[\\/]|[A-Za-z]:)/.test(path);
  const { load } = useLoad(() => (sent || !inside ? Promise.resolve(null) : invoke('files:previewUrl', { sessionId, path })), `${sessionId ?? ''}:${path}:${sent ? 'sent' : 'load'}`);
  const src = sent?.type === 'image' ? `data:${sent.mediaType};base64,${sent.data}` : load.status === 'ready' ? (load.data?.url ?? null) : null;
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
  return (
    <div className="flex flex-col gap-6">
      {src ? (
        <img src={src} alt={`The picture ${name}`} className="graft-checker block max-h-[320px] w-auto max-w-full self-start rounded-sm border border-border-card object-contain" />
      ) : (
        <p className="flex items-center gap-6 text-sm text-fg-muted">
          <FileText className="size-12" aria-hidden="true" />
          {load.status === 'loading' ? 'Loading the picture…' : 'Image'}
        </p>
      )}
      <div className="flex items-center gap-2">
        <span className="selectable min-w-0 truncate font-mono text-2xs text-fg-faint" title={path}>
          {path}
        </span>
        {inside ? (
          <>
            <IconButton label="Copy path" size="xs" onClick={() => run('copy-path', { path, type: 'file' })}>
              <Copy className="size-12" />
            </IconButton>
            <IconButton label="Show in folder" size="xs" onClick={() => run('reveal', { path, type: 'file' })}>
              <FolderOpen className="size-12" />
            </IconButton>
            <FileMenu sessionId={sessionId} target={{ path, type: 'file' }} />
          </>
        ) : null}
      </div>
    </div>
  );
}

/** What the project's language server found wrong with a file right after an edit: the same list the agent was given. */
function Problems({ found }: { found: NonNullable<Extract<ToolDisplay, { kind: 'edit' }>['problems']> }) {
  const more = found.total - found.items.length;
  return (
    <section aria-label="Problems after this change" className="flex flex-col gap-2">
      <p className="text-sm text-amber-fg">
        {found.source} found {found.total === 1 ? '1 problem' : `${String(found.total)} problems`} in the file after this change
      </p>
      <ul className="selectable flex flex-col gap-1 font-mono text-2xs text-fg-secondary">
        {found.items.map((problem, i) => (
          <li key={i} className="flex gap-8">
            <span className="w-44 shrink-0 text-right text-fg-faint tabular-nums">
              {problem.line}:{problem.column}
            </span>
            <span className="min-w-0 break-words">{problem.text}</span>
          </li>
        ))}
      </ul>
      {more > 0 ? <p className="text-2xs text-fg-faint">and {more} more</p> : null}
    </section>
  );
}

function DisplayBody({ display, result }: { display: ToolDisplay; result: ToolResultBlock }) {
  switch (display.kind) {
    case 'shell':
      return (
        <div className="flex flex-col gap-6">
          <Output text={`$ ${display.command}`} className={COMMAND} />
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
          {display.output ? <Output text={display.output} className={OUTPUT} /> : <p className="text-sm text-fg-muted">No output.</p>}
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
          {display.output ? <Output text={display.output} className={OUTPUT} /> : null}
        </div>
      );
    case 'kill-shell':
      return <p className="text-sm text-fg-muted">{display.killed ? `Stopped ${display.shellId}.` : `${display.shellId} had already finished.`}</p>;
    case 'read':
      if (display.image) return <ReadImage path={display.path} result={result} />;
      return (
        <p className="flex items-center gap-6 text-sm text-fg-muted">
          <FileText className="size-12" aria-hidden="true" />
          Lines {display.startLine}–{display.endLine} of {display.totalLines}
        </p>
      );
    case 'edit':
      return (
        <div className="flex flex-col gap-6">
          <EditDiff patch={display.patch} path={display.path} />
          {display.problems ? <Problems found={display.problems} /> : null}
        </div>
      );
    case 'glob':
      return (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-fg-muted">
            {display.count} {display.count === 1 ? 'match' : 'matches'} for {display.pattern}
          </p>
          {display.files.length > 0 ? <Output text={display.files.join('\n')} className={OUTPUT} /> : null}
        </div>
      );
    case 'grep':
      return (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-fg-muted">
            {display.count} {display.count === 1 ? 'result' : 'results'} for {display.pattern}
          </p>
          {display.preview ? <Output text={display.preview} className={OUTPUT} /> : null}
        </div>
      );
    case 'fetch':
      return (
        <p className="text-sm text-fg-muted">
          {display.status} · {Math.round(display.bytes / 1024)} KB{display.title ? ` · ${display.title}` : ''}
        </p>
      );
    case 'computer': {
      const shot = result.content.find((b) => b.type === 'image');
      return (
        <div className="flex flex-col gap-6">
          <p className="text-sm text-fg-muted">{display.summary}</p>
          {shot && shot.type === 'image' ? (
            <div className="relative self-start overflow-hidden rounded-sm border border-border-card">
              <img src={`data:${shot.mediaType};base64,${shot.data}`} alt={`The screen after: ${display.summary}`} className="block max-h-[320px] w-auto" />
              {display.point ? (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute size-16 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent shadow-[0_0_0_2px_rgba(0,0,0,0.35)]"
                  style={{ left: `${(display.point.x / display.width) * 100}%`, top: `${(display.point.y / display.height) * 100}%` }}
                />
              ) : null}
            </div>
          ) : null}
        </div>
      );
    }
    case 'browser': {
      const shot = result.content.find((b) => b.type === 'image');
      return (
        <div className="flex flex-col gap-6">
          <p className="text-sm text-fg-muted">
            {display.detail}
            {display.title ? ` · ${display.title}` : ''}
          </p>
          {display.url ? <p className="selectable truncate font-mono text-xs text-fg-faint">{display.url}</p> : null}
          {shot && shot.type === 'image' ? (
            <img
              src={`data:${shot.mediaType};base64,${shot.data}`}
              alt={`Screenshot of ${display.url || 'the page'}`}
              className="max-h-[320px] self-start rounded-sm border border-border-card object-contain"
            />
          ) : null}
        </div>
      );
    }
    case 'media':
      return (
        <div className="flex flex-col gap-6">
          <p className="text-sm text-fg-muted">
            {display.model || display.engine}
            {display.costUsd !== null && display.costUsd > 0 ? ` · $${display.costUsd.toFixed(display.costUsd < 0.1 ? 3 : 2)}` : ''}
            {display.files.length > 0 ? ` · ${display.files.map((f) => f.path).join(', ')}` : ''}
          </p>
          {display.prompt ? <p className="selectable text-sm whitespace-pre-wrap text-fg-secondary">{display.prompt}</p> : null}
          <div className="flex flex-wrap gap-6">
            {display.files.map((file) =>
              file.thumb ? <img key={file.path} src={`data:image/jpeg;base64,${file.thumb}`} alt={`Generated: ${file.path}`} className="max-h-[200px] rounded-sm border border-border-card object-contain" /> : null
            )}
          </div>
        </div>
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
    case 'mission':
      return (
        <p className="selectable text-sm whitespace-pre-wrap text-fg-secondary">
          {display.action === 'note' && display.noteKind ? <span className="text-fg-muted">{display.noteKind}: </span> : null}
          {display.text}
        </p>
      );
    case 'agents':
      return (
        <div className="flex flex-col gap-6">
          <ul aria-label="Agents" className="flex flex-col gap-3">
            {display.agents.map((agent) => (
              <li key={agent.nodeId} className="flex items-center gap-6 text-sm">
                {isAgentStatus(agent.status) ? <AgentStatusGlyph status={agent.status} /> : null}
                <span className="min-w-0 truncate text-fg-secondary">{agent.title}</span>
                <span className="shrink-0 text-2xs text-fg-faint tabular-nums">
                  {agent.role}
                  {isAgentStatus(agent.status) && agent.status !== 'done' ? ` · ${AGENT_STATUS_LABEL[agent.status].toLowerCase()}` : ''}
                  {agent.durationMs !== null ? ` · ${formatDuration(agent.durationMs)}` : ''}
                </span>
              </li>
            ))}
          </ul>
          <button type="button" onClick={showAgents} className="self-start text-sm text-link hover:underline">
            Open the agent graph
          </button>
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
      return <Output text={display.text} className={OUTPUT} />;
    case 'web-search':
      return <SearchResultList results={display.results} />;
    case 'file':
      return (
        <div className="flex flex-col gap-6">
          <p className="text-sm text-fg-muted">
            {display.name} · {fileSize(display.size)}
          </p>
          {display.preview ? <Output text={display.preview} className={OUTPUT} /> : null}
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
          {display.output ? <Output text={display.output} className={OUTPUT} /> : !display.error ? <p className="text-sm text-fg-muted">No output.</p> : null}
          {display.error ? <Output text={display.error} className={cn(OUTPUT, 'text-danger')} /> : null}
        </div>
      );
    case 'denied':
      return <p className="text-sm text-fg-muted">Not run: {display.reason}</p>;
    case 'error':
      return <p className="selectable text-sm text-danger">{display.message}</p>;
    case 'text':
      return <Output text={display.text} className={OUTPUT} />;
  }
  return <Output text={resultText(result)} className={OUTPUT} />;
}

/**
 * One edit as a diff: the file it changed and its line counts above, the
 * lines below with their changed words marked. `path` also picks the syntax
 * colours; `named` false leaves the path out of the header where it is
 * already written in full nearby. Keys, tokens and passwords in the lines
 * are covered until the eye is pressed, as they are in output; `covered`
 * false shows every line as it is, for a change that is being approved.
 */
export function EditDiff({ patch, path, named = true, covered = true }: { patch: string; path?: string; named?: boolean; covered?: boolean }) {
  const rows = useMemo(() => parsePatch(patch), [patch]);
  // In a code session's transcript the lines can be commented on for the agent. A change waiting for approval is outside it.
  const conversation = useContext(ConversationContext);
  const comments = useDiffComments(conversation?.kind === 'code' ? conversation.sessionId : null, path ?? null);
  const covers = useMemo(() => (covered ? coveredRows(rows) : null), [rows, covered]);
  const [shown, setShown] = useState(false);
  const { added, removed } = countChanges(rows);
  return (
    <div className="overflow-hidden rounded-sm border border-border-card">
      <div className="flex items-center gap-8 border-b border-border-card bg-sunken px-8 py-2 font-mono text-2xs">
        {path && named ? (
          // Cut at the start, so a long path still ends in its file name.
          <span className="selectable min-w-0 flex-1 truncate text-left text-fg-muted [direction:rtl]" title={path}>
            <bdi>{path}</bdi>
          </span>
        ) : (
          <span className="flex-1" />
        )}
        <span className="shrink-0 text-diff-add">+{added}</span>
        <span className="shrink-0 text-diff-del">-{removed}</span>
        {covers && covers.size > 0 ? <SecretsToggle shown={shown} onChange={setShown} /> : null}
      </div>
      <DiffView rows={rows} mode="unified" language={path ? languageForPath(path) : null} gutter="one" hunkHeaders={false} covers={shown ? null : covers} comments={comments} className="max-h-[320px] overflow-y-auto" />
    </div>
  );
}

/** Body of one tool call in an expanded group: exact command, output, diff, or result text. */
export function ToolCallBody({ call }: { call: ToolCall }) {
  if (call.running) {
    return call.running.output ? <Output text={call.running.output} className={OUTPUT} /> : <p className="text-sm text-fg-muted">Running…</p>;
  }
  if (!call.result) return <p className="text-sm text-fg-muted">Waiting to run.</p>;
  if (call.result.display) return <DisplayBody display={call.result.display} result={call.result} />;
  const text = resultText(call.result);
  return text ? <Output text={text} className={cn(OUTPUT, call.result.isError && 'text-danger')} /> : <p className="text-sm text-fg-muted">No output.</p>;
}
