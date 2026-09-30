import { useEffect, useState } from 'react';
import { FolderOpen, FolderPlus, GitBranch, Laptop } from 'lucide-react';
import type { BranchList } from '@shared/schemas/app';
import { Chip } from '../../components/Badge';
import { IconButton } from '../../components/Button';
import { Checkbox } from '../../components/Field';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '../../components/Menu';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/Popover';
import { cn } from '../../lib/cn';
import { baseName, shortenPath } from '../../lib/format';
import { errorText, invoke } from '../../lib/ipc';
import { useApp } from '../../stores/app';
import { reportError } from '../../stores/toasts';
import { useUi, type CodeContext } from '../../stores/ui';
import { chooseProject } from './codeContext';

export async function pickProjectFolder(): Promise<string | null> {
  const chosen = await invoke('dialog:pickFolder', { title: 'Choose a project folder' });
  if (chosen) await chooseProject(chosen);
  return chosen;
}

function EnvironmentChip() {
  const env = useApp((s) => s.environment);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Chip icon={<Laptop className="size-14 text-icon" />}>Local</Chip>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-[280px] p-12">
        <p className="text-base font-medium text-fg-strong">Runs on this computer</p>
        <p className="mt-4 text-sm text-fg-muted">Sessions use your local files, tools and credentials.</p>
        {env ? (
          <dl className="mt-10 grid grid-cols-[auto_1fr] gap-x-12 gap-y-4 text-sm">
            <dt className="text-fg-muted">Shell</dt>
            <dd className="truncate text-fg-secondary" title={env.shell.path}>
              {env.shell.label}
            </dd>
            <dt className="text-fg-muted">Git</dt>
            <dd className="text-fg-secondary">{env.git.available ? (env.git.version ?? 'Installed') : 'Not found'}</dd>
            <dt className="text-fg-muted">Search</dt>
            <dd className="text-fg-secondary">{env.ripgrep ? 'ripgrep' : 'Built-in (ripgrep not found)'}</dd>
            <dt className="text-fg-muted">GitHub CLI</dt>
            <dd className="text-fg-secondary">{env.gh ? 'Installed' : 'Not found'}</dd>
          </dl>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function FolderChip({ context }: { context: CodeContext }) {
  const projects = useApp((s) => s.projects);
  const recent = projects.filter((p) => p.exists).slice(0, 8);
  const label = context.projectPath ? baseName(context.projectPath) : 'Choose folder';
  return (
    <Menu>
      <MenuTrigger asChild>
        <Chip icon={<FolderOpen className="size-14 text-icon" />} title={context.projectPath ?? undefined}>
          {label}
        </Chip>
      </MenuTrigger>
      <MenuContent side="top" align="start" className="w-[300px]">
        {recent.length > 0 ? <MenuLabel>Recent folders</MenuLabel> : null}
        {recent.map((p) => (
          <MenuItem
            key={p.id}
            checked={p.path === context.projectPath}
            description={shortenPath(p.path, 44)}
            onSelect={() => void chooseProject(p.path).catch((e: unknown) => reportError("Couldn't use that folder", e))}
          >
            {p.name}
          </MenuItem>
        ))}
        {recent.length > 0 ? <MenuSeparator /> : null}
        <MenuItem icon={<FolderPlus className="size-14" />} onSelect={() => void pickProjectFolder().catch((e: unknown) => reportError("Couldn't open that folder", e))}>
          Choose another folder…
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

export type BranchState = { status: 'none' } | { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; list: BranchList };

/** Branches of the chosen folder (for the branch chip and the worktree tip). */
export function useBranches(path: string | null | undefined): BranchState {
  const [result, setResult] = useState<{ path: string; state: BranchState } | null>(null);
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    invoke('git:branches', { path })
      .then((list) => {
        if (!cancelled) setResult({ path, state: { status: 'ready', list } });
      })
      .catch((error: unknown) => {
        if (!cancelled) setResult({ path, state: { status: 'error', message: errorText(error) } });
      });
    return () => {
      cancelled = true;
    };
  }, [path]);
  if (!path) return { status: 'none' };
  if (!result || result.path !== path) return { status: 'loading' };
  return result.state;
}

function BranchChip({ context, state }: { context: CodeContext; state: BranchState }) {
  const setContext = useUi((s) => s.setCodeContext);
  const path = context.projectPath;

  if (!path || state.status === 'loading' || state.status === 'none') return null;
  if (state.status === 'error') {
    return (
      <Chip icon={<GitBranch className="size-14 text-danger" />} disabled title={state.message}>
        Git unavailable
      </Chip>
    );
  }
  if (!state.list.isRepo) return null;

  const current = state.list.current;
  const base = context.branch ?? current ?? 'HEAD';
  const locals = state.list.branches.filter((b) => !b.remote);
  return (
    <div className="inline-flex h-22 shrink-0 items-center rounded-sm border border-chip-edge bg-control text-base text-fg-secondary">
      <Menu>
        <MenuTrigger asChild>
          <button
            type="button"
            className="inline-flex h-full max-w-[180px] items-center gap-6 rounded-l-sm px-6 transition-ui hover:text-fg"
            aria-label={`Base branch: ${base}`}
          >
            <GitBranch className="size-14 shrink-0 text-icon" aria-hidden="true" />
            <span className="truncate">{base}</span>
          </button>
        </MenuTrigger>
        <MenuContent side="top" align="start" className="max-h-[min(360px,60vh)] w-[260px] overflow-y-auto">
          <MenuLabel>{context.useWorktree ? 'New worktree starts from' : 'Choosing another branch starts a worktree from it'}</MenuLabel>
          {locals.map((b) => (
            <MenuItem
              key={b.name}
              checked={b.name === base}
              trailing={b.current ? <span className="text-sm text-fg-muted">current</span> : undefined}
              onSelect={() =>
                setContext({ ...context, branch: b.current ? null : b.name, useWorktree: b.current ? context.useWorktree : true })
              }
            >
              {b.name}
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>
      <span className="h-12 w-px bg-border" aria-hidden="true" />
      <Checkbox
        label="worktree"
        checked={context.useWorktree}
        onChange={(e) => setContext({ ...context, useWorktree: e.target.checked, branch: e.target.checked ? context.branch : null })}
        className="h-full rounded-r-sm px-6 hover:text-fg"
      />
    </div>
  );
}

/** Environment, folder, branch (+ worktree) and add-folder chips above the Code home composer. */
export function ContextChips({ context, branches, className }: { context: CodeContext; branches: BranchState; className?: string }) {
  return (
    <div className={cn('flex min-w-0 flex-wrap items-center gap-6', className)}>
      <EnvironmentChip />
      <FolderChip context={context} />
      <BranchChip context={context} state={branches} />
      <IconButton
        label="Add a folder"
        size="sm"
        className="h-22 border border-chip-edge bg-control"
        onClick={() => void pickProjectFolder().catch((e: unknown) => reportError("Couldn't open that folder", e))}
      >
        <FolderPlus className="size-14" />
      </IconButton>
    </div>
  );
}
