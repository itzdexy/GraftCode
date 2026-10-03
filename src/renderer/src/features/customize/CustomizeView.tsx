import { useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Button } from '../../components/Button';
import { cn } from '../../lib/cn';
import { invoke } from '../../lib/ipc';
import { useApp } from '../../stores/app';
import { reportError } from '../../stores/toasts';
import { PageLayout } from '../shell/PageLayout';
import { AgentsSection } from './AgentsSection';
import { CommandsSection } from './CommandsSection';
import { HooksSection } from './HooksSection';
import { McpSection } from './McpSection';
import { MemorySection } from './MemorySection';
import { SELECT } from './shared';
import { SkillsSection } from './SkillsSection';

export type CustomizeTab = 'commands' | 'agents' | 'skills' | 'mcp' | 'hooks' | 'memory';

const TABS: Array<{ id: CustomizeTab; label: string }> = [
  { id: 'commands', label: 'Commands' },
  { id: 'agents', label: 'Agents' },
  { id: 'skills', label: 'Skills' },
  { id: 'mcp', label: 'MCP servers' },
  { id: 'hooks', label: 'Hooks' },
  { id: 'memory', label: 'Memory' }
];

/** Commands, skills, MCP servers, hooks and memory files, for everything or one project. */
export function CustomizeView({ initialTab = 'commands' }: { initialTab?: CustomizeTab }) {
  const projects = useApp((s) => s.projects);
  const lastProject = useApp((s) => s.settings?.defaults.lastProjectPath ?? null);
  const [tab, setTab] = useState<CustomizeTab>(initialTab);
  const [projectPath, setProjectPath] = useState<string | null>(() => projects.find((p) => p.path === lastProject)?.path ?? projects[0]?.path ?? null);
  const project = projects.find((p) => p.path === projectPath) ?? null;

  const trust = (): void => {
    if (!project) return;
    invoke('projects:update', { id: project.id, trusted: true })
      .then((p) => useApp.getState().upsertProject(p))
      .catch((e: unknown) => reportError("Couldn't trust the project", e));
  };

  return (
    <PageLayout
      title="Customize"
      description="Shape how Graft works: reusable prompts, specialist agents, skills, tools from MCP servers, hooks and standing instructions."
      actions={
        <label className="flex items-center gap-8 text-sm text-fg-muted">
          Project
          <select aria-label="Project" className={cn(SELECT, 'w-[220px]')} value={projectPath ?? ''} onChange={(e) => setProjectPath(e.target.value || null)}>
            <option value="">None (only “all projects” items)</option>
            {projects.map((p) => (
              <option key={p.id} value={p.path}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      }
    >
      <div role="tablist" aria-label="Customize" className="mb-20 flex flex-wrap gap-4 border-b border-border-subtle">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cn('-mb-px h-32 border-b-2 px-10 text-base transition-ui', tab === t.id ? 'border-fg-strong text-fg-strong' : 'border-transparent text-fg-muted hover:text-fg-secondary')}
          >
            {t.label}
          </button>
        ))}
      </div>
      {project && !project.trusted && (tab === 'mcp' || tab === 'hooks') ? (
        <div className="mb-16 flex items-center gap-10 rounded-md border border-border bg-warning-bg px-12 py-8 text-sm text-warning-fg">
          <ShieldAlert className="size-16 shrink-0" aria-hidden="true" />
          <p className="flex-1">{project.name} isn’t trusted, so its own hooks, MCP servers and allow rules are off. Your “all projects” items still apply.</p>
          <Button size="sm" variant="secondary" onClick={trust}>
            Trust project
          </Button>
        </div>
      ) : null}
      <div role="tabpanel" aria-label={TABS.find((t) => t.id === tab)?.label}>
        {tab === 'commands' ? <CommandsSection projectPath={projectPath} /> : null}
        {tab === 'agents' ? <AgentsSection projectPath={projectPath} /> : null}
        {tab === 'skills' ? <SkillsSection projectPath={projectPath} /> : null}
        {tab === 'mcp' ? <McpSection projectPath={projectPath} /> : null}
        {tab === 'hooks' ? <HooksSection projectPath={projectPath} /> : null}
        {tab === 'memory' ? <MemorySection projectPath={projectPath} /> : null}
      </div>
    </PageLayout>
  );
}
