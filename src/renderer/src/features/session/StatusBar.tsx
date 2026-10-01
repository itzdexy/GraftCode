import { useEffect, useState } from 'react';
import { ChevronDown, Copy, FolderOpen, GitCommitHorizontal, GitPullRequest, Upload, X } from 'lucide-react';
import type { DiffStatsView } from '@shared/schemas/app';
import type { SessionSummary } from '@shared/schemas/sessions';
import { IconButton } from '../../components/Button';
import { Spinner } from '../../components/ContextRing';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../../components/Menu';
import { errorText, invoke } from '../../lib/ipc';
import { logError } from '../../lib/log';
import { reportError, useToasts } from '../../stores/toasts';
import { useUi } from '../../stores/ui';
import { CommitDialog } from './CommitDialog';

const POLL_MS = 15_000;

/** Live diff stats for a session's folder, refreshed on `refreshKey` changes and periodically. */
export function useDiffStats(sessionId: string, refreshKey: unknown): DiffStatsView | null {
  const [stats, setStats] = useState<DiffStatsView | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      invoke('git:diffStats', { sessionId })
        .then((value) => {
          if (!cancelled) setStats(value);
        })
        .catch((error: unknown) => logError('Could not read diff stats', error));
    };
    load();
    const timer = setInterval(load, POLL_MS);
    const onFocus = (): void => load();
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [sessionId, refreshKey]);
  return stats;
}

function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * Git status under the transcript: project and branch, +added / −removed,
 * and the Create PR split button (commit, commit & push, copy branch, open
 * in editor). Hidden outside git repositories.
 */
export function StatusBar({ summary, stats, onChanged }: { summary: SessionSummary; stats: DiffStatsView | null; onChanged: () => void }) {
  const hidden = useUi((s) => s.hiddenStatusBars[summary.id] === true);
  const [busy, setBusy] = useState(false);
  const [commit, setCommit] = useState<{ push: boolean } | null>(null);
  if (hidden || !stats?.branch) return null;
  const workDir = summary.worktreePath ?? summary.cwd;

  const createPr = async (): Promise<void> => {
    setBusy(true);
    try {
      const pr = await invoke('git:createPr', { sessionId: summary.id });
      if (pr.via === 'browser') {
        await invoke('app:openExternal', { url: pr.url });
        useToasts.getState().push({ tone: 'info', title: 'Branch pushed', description: 'Finish the pull request in your browser.' });
      } else {
        useToasts.getState().push({
          tone: 'success',
          title: 'Pull request created',
          description: pr.url,
          action: {
            label: 'Open',
            run: () => {
              invoke('app:openExternal', { url: pr.url }).catch((e: unknown) => reportError("Couldn't open the link", e));
            }
          }
        });
      }
      onChanged();
    } catch (error) {
      useToasts.getState().push({ tone: 'error', title: "Couldn't create the pull request", description: errorText(error) });
    } finally {
      setBusy(false);
    }
  };

  const copyBranch = (): void => {
    navigator.clipboard.writeText(stats.branch ?? '').then(
      () => useToasts.getState().push({ tone: 'success', title: 'Branch name copied' }),
      (error: unknown) => reportError("Couldn't copy to the clipboard", error)
    );
  };

  return (
    <div className="flex h-[var(--g-status-bar-height)] items-center gap-8 rounded-md bg-raised pr-6 pl-12 text-md">
      <span className="truncate text-fg-secondary">{summary.projectName ?? 'Project'}</span>
      <span className="min-w-0 truncate font-mono text-sm text-fg-muted" title={stats.branch}>
        {stats.branch}
      </span>
      <div className="flex-1" />
      {stats.added > 0 || stats.removed > 0 ? (
        <span
          role="img"
          className="inline-flex h-22 shrink-0 items-center gap-6 rounded-xs bg-strong px-6 font-mono text-sm"
          aria-label={`${stats.added} ${stats.added === 1 ? 'line' : 'lines'} added, ${stats.removed} removed`}
        >
          <span className="text-diff-add">+{formatCount(stats.added)}</span>
          <span className="text-diff-del">-{formatCount(stats.removed)}</span>
        </span>
      ) : null}
      <div className="inline-flex h-24 shrink-0 items-center rounded-sm bg-btn-ghost">
        <button
          type="button"
          disabled={busy}
          onClick={() => void createPr()}
          className="inline-flex h-full items-center gap-6 rounded-l-sm px-8 text-base text-fg-secondary transition-ui hover:bg-hover hover:text-fg disabled:text-fg-faint"
        >
          {busy ? <Spinner size={12} label="Creating pull request" /> : <GitPullRequest className="size-14" aria-hidden="true" />}
          Create PR
        </button>
        <span className="h-14 w-px bg-border" aria-hidden="true" />
        <Menu>
          <MenuTrigger asChild>
            <button
              type="button"
              aria-label="More git actions"
              className="inline-flex h-full items-center rounded-r-sm px-4 text-icon transition-ui hover:bg-hover hover:text-icon-strong data-[state=open]:bg-hover"
            >
              <ChevronDown className="size-14" />
            </button>
          </MenuTrigger>
          <MenuContent side="top" align="end" className="w-[220px]">
            <MenuItem icon={<GitPullRequest className="size-14" />} onSelect={() => void createPr()} disabled={busy}>
              Create PR
            </MenuItem>
            <MenuItem icon={<GitCommitHorizontal className="size-14" />} onSelect={() => setCommit({ push: false })}>
              Commit…
            </MenuItem>
            <MenuItem icon={<Upload className="size-14" />} onSelect={() => setCommit({ push: true })}>
              Commit &amp; push…
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<Copy className="size-14" />} onSelect={copyBranch}>
              Copy branch name
            </MenuItem>
            {workDir ? (
              <MenuItem
                icon={<FolderOpen className="size-14" />}
                onSelect={() => {
                  invoke('app:openInEditor', { path: workDir }).catch((e: unknown) => reportError("Couldn't open the folder", e));
                }}
              >
                Open in editor
              </MenuItem>
            ) : null}
          </MenuContent>
        </Menu>
      </div>
      <IconButton label="Hide git status" size="xs" onClick={() => useUi.getState().hideStatusBar(summary.id)}>
        <X className="size-14" />
      </IconButton>
      <CommitDialog
        sessionId={summary.id}
        open={commit !== null}
        push={commit?.push ?? false}
        onOpenChange={(open) => {
          if (!open) setCommit(null);
        }}
        onDone={() => {
          setCommit(null);
          onChanged();
        }}
      />
    </div>
  );
}
