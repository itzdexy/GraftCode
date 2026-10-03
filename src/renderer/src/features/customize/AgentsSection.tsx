import { useState } from 'react';
import { Bot, Pencil, Plus, Trash } from 'lucide-react';
import type { AgentFileView, CustomScopeView } from '@shared/schemas/customize';
import { Badge } from '../../components/Badge';
import { Button, IconButton } from '../../components/Button';
import { Dialog, DialogContent } from '../../components/Dialog';
import { Checkbox, TextField } from '../../components/Field';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { errorText, invoke } from '../../lib/ipc';
import { useLoad } from '../../lib/useLoad';
import { reportError } from '../../stores/toasts';
import { MONO_AREA, Row, Section, SELECT } from './shared';

interface Draft {
  name: string;
  description: string;
  tools: string[] | null;
  body: string;
}

/** Starting points for a new agent; everything stays editable. */
const TEMPLATES: Array<{ label: string; draft: Draft }> = [
  {
    label: 'Code reviewer',
    draft: {
      name: 'reviewer',
      description: 'Reviews a change for bugs, risky edits and missing tests, without changing files',
      tools: ['Read', 'Glob', 'Grep', 'Shell'],
      body: [
        'You review code changes the way a careful senior engineer would.',
        '',
        '- Start from the diff (git diff, staged changes included), then read the surrounding code and the callers of anything that changed.',
        '- Look for real problems: logic errors, unhandled edge cases, broken error handling, race conditions, security issues, performance traps and missing tests.',
        '- Report each finding with its severity, path:line, why it is a problem and a concrete fix. Skip style nitpicks unless they hide a bug.',
        '- Say plainly when the change looks good. Never edit files.'
      ].join('\n')
    }
  },
  {
    label: 'Test writer',
    draft: {
      name: 'test-writer',
      description: 'Writes focused tests for a module or a bug fix, in the project’s own test style',
      tools: null,
      body: [
        'You write tests that pin down behavior.',
        '',
        '- Find how the project tests similar code (framework, file layout, helpers, naming) and follow it exactly.',
        '- Cover the main behavior, the edge cases and the failure paths. One behavior per test, with names that say what is expected.',
        '- Run the new tests and make sure they pass for the right reason; when a test exposes a real bug, report it instead of bending the test.',
        '- Report which tests you added, what they cover and the command that runs them.'
      ].join('\n')
    }
  },
  {
    label: 'Debugger',
    draft: {
      name: 'debugger',
      description: 'Finds the root cause of a failure or wrong behavior and proposes the smallest correct fix',
      tools: null,
      body: [
        'You track down bugs methodically.',
        '',
        '1. Reproduce the problem and capture the exact error or wrong output.',
        '2. Form hypotheses and test them with evidence: logs, small experiments, reading the code path end to end.',
        '3. Find the root cause, not just the place where it surfaces.',
        '4. Make the smallest change that fixes the cause, then rerun the reproduction and the relevant tests.',
        '',
        'Report the cause, the evidence, the fix and how you verified it.'
      ].join('\n')
    }
  }
];

const EMPTY: Draft = { name: '', description: '', tools: null, body: '' };

function AgentEditor({ agent, projectPath, onDone }: { agent: AgentFileView | null; projectPath: string | null; onDone: (saved: boolean) => void }) {
  const [scope, setScope] = useState<CustomScopeView>(agent?.scope ?? (projectPath ? 'project' : 'user'));
  const [draft, setDraft] = useState<Draft>(agent ? { name: agent.name, description: agent.description, tools: agent.tools, body: agent.body } : EMPTY);
  const [error, setError] = useState<string | null>(null);
  const toolList = useLoad(() => invoke('customize:agentTools'), 'agent-tools');
  const limited = draft.tools !== null;

  const set = (patch: Partial<Draft>): void => setDraft((d) => ({ ...d, ...patch }));
  const toggleTool = (tool: string, on: boolean): void => {
    const current = draft.tools ?? [];
    set({ tools: on ? [...current, tool] : current.filter((t) => t !== tool) });
  };

  const save = async (): Promise<void> => {
    try {
      await invoke('customize:saveAgent', {
        scope,
        projectPath,
        name: draft.name.trim().toLowerCase(),
        description: draft.description,
        tools: draft.tools && draft.tools.length > 0 ? draft.tools : null,
        body: draft.body,
        previousPath: agent?.path ?? null
      });
      onDone(true);
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <DialogContent
      title={agent ? `Edit ${agent.name}` : 'New agent'}
      description="Graft hands an agent a task with its own fresh context and these instructions. It reports back when done."
      className="w-[min(680px,calc(100vw-48px))]"
      footer={
        <>
          <Button variant="ghost" onClick={() => onDone(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!draft.name.trim() || !draft.body.trim()} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-12">
        {agent ? null : (
          <div className="flex flex-wrap items-center gap-6">
            <span className="text-sm text-fg-muted">Start from</span>
            {TEMPLATES.map((t) => (
              <Button key={t.label} size="xs" variant="secondary" onClick={() => setDraft(t.draft)}>
                {t.label}
              </Button>
            ))}
          </div>
        )}
        <div className="grid grid-cols-[1fr_160px] gap-8">
          <TextField label="Name" value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="reviewer" spellCheck={false} />
          <label className="flex flex-col gap-6 text-base font-medium text-fg-secondary">
            Saved for
            <select className={SELECT} value={scope} onChange={(e) => setScope(e.target.value as CustomScopeView)}>
              <option value="user">All projects</option>
              <option value="project" disabled={!projectPath}>
                This project
              </option>
            </select>
          </label>
        </div>
        <TextField
          label="When should Graft use it?"
          value={draft.description}
          onChange={(e) => set({ description: e.target.value })}
          placeholder="Reviews a change for bugs and risky edits"
        />
        <fieldset className="flex flex-col gap-6">
          <legend className="mb-6 text-base font-medium text-fg-secondary">Tools</legend>
          <Checkbox label="Limit the tools this agent can use" checked={limited} onChange={(e) => set({ tools: e.target.checked ? ['Read', 'Glob', 'Grep'] : null })} />
          {limited ? (
            toolList.load.status === 'ready' ? (
              <div className="grid grid-cols-4 gap-x-12 gap-y-4 pl-16">
                {toolList.load.data.map((tool) => (
                  <Checkbox key={tool} label={<span className="font-mono text-sm">{tool}</span>} checked={draft.tools?.includes(tool) ?? false} onChange={(e) => toggleTool(tool, e.target.checked)} />
                ))}
              </div>
            ) : (
              <p className="pl-16 text-sm text-fg-muted">Loading tools…</p>
            )
          ) : (
            <p className="pl-16 text-sm text-fg-muted">It gets the same tools as a general sub-agent. Every action still follows your permission settings.</p>
          )}
        </fieldset>
        <label className="flex flex-col gap-6 text-base font-medium text-fg-secondary">
          Instructions
          <textarea className={MONO_AREA} rows={10} value={draft.body} onChange={(e) => set({ body: e.target.value })} placeholder="You review code changes…" />
        </label>
        {error ? (
          <p role="alert" className="text-base text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </DialogContent>
  );
}

/** Custom sub-agents (user and project) the main agent can hand tasks to. */
export function AgentsSection({ projectPath }: { projectPath: string | null }) {
  const { load, reload } = useLoad(() => invoke('customize:agents', { projectPath }), projectPath ?? '');
  const [editing, setEditing] = useState<AgentFileView | 'new' | null>(null);

  const remove = (a: AgentFileView): void => {
    invoke('customize:deleteAgent', { projectPath, path: a.path })
      .then(reload)
      .catch((e: unknown) => reportError("Couldn't delete the agent", e));
  };

  return (
    <Section
      title="Agents"
      description="Specialists Graft can hand a task to, such as a reviewer or a test writer. Each works in its own context with its own instructions and tools. Stored as Markdown in ~/.graft/agents or the project's .graft/agents."
      actions={
        <Button size="sm" variant="secondary" leading={<Plus className="size-14" />} onClick={() => setEditing('new')}>
          New agent
        </Button>
      }
    >
      {load.status === 'loading' ? <LoadingState /> : null}
      {load.status === 'error' ? <ErrorState message={load.message} onRetry={reload} /> : null}
      {load.status === 'ready' && load.data.length === 0 ? (
        <EmptyState
          icon={<Bot className="size-20" />}
          title="No agents yet"
          description="Create one from a template, then ask Graft to use it by name, or let it pick one when a task fits."
        />
      ) : null}
      {load.status === 'ready' && load.data.length > 0 ? (
        <ul className="flex flex-col gap-[var(--g-session-row-gap)]">
          {load.data.map((a) => (
            <Row key={a.path}>
              <Bot className="size-16 shrink-0 text-accent" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-8">
                  <span className="font-mono text-base text-fg-strong">{a.name}</span>
                  <Badge>{a.scope === 'user' ? 'All projects' : 'This project'}</Badge>
                  <Badge>{a.tools ? `${a.tools.length} ${a.tools.length === 1 ? 'tool' : 'tools'}` : 'All tools'}</Badge>
                </p>
                <p className="truncate text-sm text-fg-muted">{a.description}</p>
              </div>
              <IconButton label={`Edit ${a.name}`} onClick={() => setEditing(a)}>
                <Pencil className="size-14" />
              </IconButton>
              <IconButton label={`Delete ${a.name}`} onClick={() => remove(a)}>
                <Trash className="size-14" />
              </IconButton>
            </Row>
          ))}
        </ul>
      ) : null}
      <Dialog open={editing !== null} onOpenChange={(open) => (open ? undefined : setEditing(null))}>
        {editing ? (
          <AgentEditor
            key={editing === 'new' ? 'new' : editing.path}
            agent={editing === 'new' ? null : editing}
            projectPath={projectPath}
            onDone={(saved) => {
              setEditing(null);
              if (saved) reload();
            }}
          />
        ) : null}
      </Dialog>
    </Section>
  );
}
