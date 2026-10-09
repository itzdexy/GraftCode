import { useCallback, useEffect, useMemo, useState } from 'react';
import { Columns2, Minus, PenLine, Plus, RefreshCw, Rows3, Undo2 } from 'lucide-react';
import type { ChangedFileView, FileDiffView, GitStatusView } from '@shared/schemas/git';
import { Button, IconButton } from '../../components/Button';
import { Spinner } from '../../components/ContextRing';
import { Dialog, DialogContent } from '../../components/Dialog';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { cn } from '../../lib/cn';
import { errorText, invoke } from '../../lib/ipc';
import { panelsOf, usePanels } from '../../stores/panels';
import { reportError, useToasts } from '../../stores/toasts';
import { DiffView } from '../diff/DiffView';
import { rowsFromHunks } from '../diff/diffModel';
import { FilesView } from './FilesPanel';
import { PanelFrame } from './PanelFrame';

type Selection = { path: string; staged: boolean } | null;
type Confirm = { title: string; detail: string; run: () => Promise<void> } | null;

const STATUS_LABEL: Record<string, string> = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed', U: 'Untracked' };

function letter(file: ChangedFileView, staged: boolean): string {
  if (staged) return file.staged ?? 'M';
  if (file.untracked) return 'U';
  return file.unstaged ?? 'M';
}

function LetterBadge({ value }: { value: string }) {
  const tone = value === 'D' ? 'text-diff-del' : value === 'A' || value === 'U' ? 'text-diff-add' : 'text-amber-fg';
  return (
    <span className={cn('w-12 shrink-0 text-center font-mono text-2xs', tone)} title={STATUS_LABEL[value] ?? value}>
      {value}
    </span>
  );
}

function FileRow({
  file,
  staged,
  selected,
  onSelect,
  onStage,
  onRevert
}: {
  file: ChangedFileView;
  staged: boolean;
  selected: boolean;
  onSelect: () => void;
  onStage: () => void;
  onRevert: (() => void) | null;
}) {
  const name = file.path.split('/').pop() ?? file.path;
  const dir = file.path.slice(0, file.path.length - name.length).replace(/\/$/, '');
  return (
    <li className={cn('group flex h-26 items-center gap-6 rounded-sm pr-2 pl-6 text-base', selected ? 'bg-selected' : 'hover:bg-hover')}>
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-6 text-left"
        aria-current={selected ? 'true' : undefined}
        aria-label={`${file.path} (${STATUS_LABEL[letter(file, staged)] ?? letter(file, staged)})`}
      >
        <LetterBadge value={letter(file, staged)} />
        <span className="truncate text-fg">{name}</span>
        {dir ? <span className="min-w-0 truncate text-sm text-fg-faint">{dir}</span> : null}
      </button>
      <div className="flex shrink-0 opacity-0 transition-ui group-focus-within:opacity-100 group-hover:opacity-100">
        {onRevert ? (
          <IconButton label={`Discard changes to ${name}`} size="xs" onClick={onRevert}>
            <Undo2 className="size-12" />
          </IconButton>
        ) : null}
        <IconButton label={staged ? `Unstage ${name}` : `Stage ${name}`} size="xs" onClick={onStage}>
          {staged ? <Minus className="size-12" /> : <Plus className="size-12" />}
        </IconButton>
      </div>
    </li>
  );
}

function CommitBox({ sessionId, stagedCount, totalCount, onDone }: { sessionId: string; stagedCount: number; totalCount: number; onDone: () => void }) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<'suggest' | 'commit' | null>(null);
  const stageAll = stagedCount === 0;

  const suggest = async (): Promise<void> => {
    setBusy('suggest');
    try {
      setMessage((await invoke('git:suggestCommitMessage', { sessionId })).message);
    } catch (error) {
      reportError("Couldn't suggest a message", error);
    } finally {
      setBusy(null);
    }
  };

  const commit = async (): Promise<void> => {
    setBusy('commit');
    try {
      const { sha } = await invoke('git:commit', { sessionId, message, stageAll });
      useToasts.getState().push({ tone: 'success', title: 'Committed', description: `${sha.slice(0, 8)} ${message.split('\n')[0] ?? ''}` });
      setMessage('');
      onDone();
    } catch (error) {
      reportError("Couldn't commit", error);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex shrink-0 flex-col gap-6 border-t border-border-panel p-8">
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        aria-label="Commit message"
        placeholder="Commit message"
        rows={3}
        className="w-full resize-none rounded-sm border border-input-border bg-input px-8 py-6 font-mono text-sm text-fg outline-none focus:border-border-strong"
      />
      <div className="flex items-center gap-6">
        <Button size="sm" variant="ghost" disabled={busy !== null || totalCount === 0} onClick={() => void suggest()} leading={busy === 'suggest' ? <Spinner size={12} label="Writing" /> : <PenLine className="size-12" />}>
          Suggest
        </Button>
        <div className="flex-1" />
        <Button size="sm" variant="primary" disabled={busy !== null || message.trim().length === 0 || totalCount === 0} onClick={() => void commit()}>
          {busy === 'commit' ? <Spinner size={12} label="Committing" /> : null}
          {stageAll ? 'Commit all' : `Commit ${stagedCount} staged`}
        </Button>
      </div>
    </div>
  );
}

type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; status: GitStatusView };

function ChangesView({ sessionId, refreshKey }: { sessionId: string; refreshKey: unknown }) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [selection, setSelection] = useState<Selection>(null);
  const [diff, setDiff] = useState<{ key: string; diff: FileDiffView } | { key: string; error: string } | null>(null);
  const [mode, setMode] = useState<'unified' | 'split'>('unified');
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    invoke('git:status', { sessionId })
      .then((status) => {
        if (!cancelled) setLoad({ state: 'ready', status });
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoad({ state: 'error', message: errorText(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, refreshKey, tick]);

  const files = useMemo(() => (load.state === 'ready' ? load.status.files : []), [load]);
  const staged = useMemo(() => files.filter((f) => f.staged !== null), [files]);
  const unstaged = useMemo(() => files.filter((f) => f.unstaged !== null || f.untracked), [files]);
  const current = selection && files.some((f) => f.path === selection.path) ? selection : null;
  const diffKey = current ? `${current.path}:${current.staged}:${tick}:${String(refreshKey)}` : null;

  useEffect(() => {
    if (!current || !diffKey) return;
    let cancelled = false;
    invoke('git:fileDiff', { sessionId, path: current.path, staged: current.staged })
      .then((d) => {
        if (!cancelled) setDiff({ key: diffKey, diff: d });
      })
      .catch((error: unknown) => {
        if (!cancelled) setDiff({ key: diffKey, error: errorText(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, current, diffKey]);

  const act = async (label: string, action: () => Promise<unknown>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      reportError(label, error);
    }
    refresh();
  };

  const stage = (paths: string[]): Promise<void> => act("Couldn't stage", () => invoke('git:stage', { sessionId, paths }));
  const unstage = (paths: string[]): Promise<void> => act("Couldn't unstage", () => invoke('git:unstage', { sessionId, paths }));
  const askRevert = (paths: string[]): void => {
    setConfirm({
      title: paths.length === 1 ? `Discard changes to ${paths[0] ?? ''}?` : `Discard changes to ${paths.length} files?`,
      detail: 'Uncommitted changes are lost and new files are deleted. This can’t be undone.',
      run: () => act("Couldn't discard the changes", () => invoke('git:revert', { sessionId, paths }))
    });
  };

  if (load.state === 'loading') return <LoadingState label="Reading changes…" />;
  if (load.state === 'error') return <ErrorState message={load.message} onRetry={refresh} />;
  if (!load.status.isRepo) return <EmptyState title="Not a git repository" description="Changes appear here for folders under git." />;

  const shown = diff && diffKey && diff.key === diffKey ? diff : null;
  const rows = shown && 'diff' in shown ? rowsFromHunks(shown.diff.hunks) : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-28 shrink-0 items-center gap-4 border-b border-border-panel pr-4 pl-10 text-sm text-fg-muted">
        <span className="min-w-0 flex-1 truncate">
          {files.length === 0 ? 'No changes' : `${files.length} changed ${files.length === 1 ? 'file' : 'files'}`}
          {load.status.branch ? ` on ${load.status.branch}` : ''}
        </span>
        <IconButton label={mode === 'unified' ? 'Side-by-side diff' : 'Unified diff'} size="xs" onClick={() => setMode(mode === 'unified' ? 'split' : 'unified')}>
          {mode === 'unified' ? <Columns2 className="size-12" /> : <Rows3 className="size-12" />}
        </IconButton>
        <IconButton label="Refresh" size="xs" onClick={refresh}>
          <RefreshCw className="size-12" />
        </IconButton>
      </div>
      <div className="max-h-[45%] shrink-0 overflow-y-auto p-4">
        {staged.length > 0 ? (
          <section aria-label="Staged changes">
            <div className="flex h-24 items-center justify-between pr-2 pl-6 text-xs text-fg-muted">
              <span>Staged ({staged.length})</span>
              <button type="button" className="hover:text-fg" onClick={() => void unstage(staged.map((f) => f.path))}>
                Unstage all
              </button>
            </div>
            <ul>
              {staged.map((f) => (
                <FileRow
                  key={`s:${f.path}`}
                  file={f}
                  staged
                  selected={current?.path === f.path && current.staged}
                  onSelect={() => setSelection({ path: f.path, staged: true })}
                  onStage={() => void unstage([f.path])}
                  onRevert={null}
                />
              ))}
            </ul>
          </section>
        ) : null}
        {unstaged.length > 0 ? (
          <section aria-label="Unstaged changes">
            <div className="flex h-24 items-center justify-between pr-2 pl-6 text-xs text-fg-muted">
              <span>Changes ({unstaged.length})</span>
              <span className="flex gap-10">
                <button type="button" className="hover:text-fg" onClick={() => askRevert(unstaged.map((f) => f.path))}>
                  Discard all
                </button>
                <button type="button" className="hover:text-fg" onClick={() => void stage(unstaged.map((f) => f.path))}>
                  Stage all
                </button>
              </span>
            </div>
            <ul>
              {unstaged.map((f) => (
                <FileRow
                  key={`u:${f.path}`}
                  file={f}
                  staged={false}
                  selected={current?.path === f.path && !current.staged}
                  onSelect={() => setSelection({ path: f.path, staged: false })}
                  onStage={() => void stage([f.path])}
                  onRevert={() => askRevert([f.path])}
                />
              ))}
            </ul>
          </section>
        ) : null}
        {files.length === 0 ? <p className="px-6 py-8 text-base text-fg-muted">The working tree matches the last commit.</p> : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto border-t border-border-panel">
        {current ? (
          shown === null ? (
            <LoadingState label="Loading diff…" />
          ) : 'error' in shown ? (
            <ErrorState message={shown.error} />
          ) : shown.diff.binary ? (
            <p className="px-10 py-8 text-base text-fg-muted">Binary file; no text diff.</p>
          ) : (
            <DiffView
              rows={rows}
              mode={mode}
              hunkActions={(hunk) => (
                <span className="flex shrink-0 gap-4 font-sans text-2xs">
                  {current.staged ? (
                    <button type="button" className="rounded-xs px-4 hover:bg-hover hover:text-fg" onClick={() => void act("Couldn't unstage the change", () => invoke('git:hunk', { sessionId, path: current.path, index: hunk, action: 'unstage' }))}>
                      Unstage
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="rounded-xs px-4 hover:bg-hover hover:text-fg"
                        onClick={() =>
                          setConfirm({
                            title: 'Discard this change?',
                            detail: `The change in ${current.path} is lost. This can’t be undone.`,
                            run: () => act("Couldn't discard the change", () => invoke('git:hunk', { sessionId, path: current.path, index: hunk, action: 'revert' }))
                          })
                        }
                      >
                        Discard
                      </button>
                      <button type="button" className="rounded-xs px-4 hover:bg-hover hover:text-fg" onClick={() => void act("Couldn't stage the change", () => invoke('git:hunk', { sessionId, path: current.path, index: hunk, action: 'stage' }))}>
                        Stage
                      </button>
                    </>
                  )}
                </span>
              )}
            />
          )
        ) : (
          <p className="px-10 py-8 text-base text-fg-muted">{files.length > 0 ? 'Select a file to see its diff.' : ''}</p>
        )}
      </div>
      <CommitBox sessionId={sessionId} stagedCount={staged.length} totalCount={files.length} onDone={refresh} />
      <Dialog open={confirm !== null} onOpenChange={(open) => (open ? undefined : setConfirm(null))}>
        {confirm ? (
          <DialogContent
            title={confirm.title}
            description={confirm.detail}
            footer={
              <>
                <Button variant="ghost" onClick={() => setConfirm(null)}>
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  onClick={() => {
                    const run = confirm.run;
                    setConfirm(null);
                    void run();
                  }}
                >
                  Discard
                </Button>
              </>
            }
          />
        ) : null}
      </Dialog>
    </div>
  );
}

/** Changes / Files panel: stage, unstage and discard by file or hunk, commit; browse files read-only. */
export function ChangesPanel({ sessionId, refreshKey, onClose }: { sessionId: string; refreshKey: unknown; onClose: () => void }) {
  const tab = usePanels((s) => panelsOf(s, sessionId).changesTab);
  const setTab = usePanels((s) => s.setChangesTab);
  return (
    <PanelFrame
      label="Changes"
      onClose={onClose}
      title={
        <div role="tablist" aria-label="Changes or files" className="flex items-center gap-2">
          {(['changes', 'files'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(sessionId, t)}
              className={cn('h-24 rounded-sm px-8 text-sm', tab === t ? 'bg-hover text-fg' : 'text-fg-muted hover:text-fg-secondary')}
            >
              {t === 'changes' ? 'Changes' : 'Files'}
            </button>
          ))}
        </div>
      }
    >
      {tab === 'changes' ? <ChangesView sessionId={sessionId} refreshKey={refreshKey} /> : <FilesView key={sessionId} sessionId={sessionId} refreshKey={refreshKey} />}
    </PanelFrame>
  );
}
