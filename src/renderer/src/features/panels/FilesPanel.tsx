import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, File, Folder, FolderOpen } from 'lucide-react';
import type { TreeEntryView, FilePreviewView } from '@shared/schemas/panels';
import { ErrorState, LoadingState } from '../../components/States';
import { cn } from '../../lib/cn';
import { languageForPath } from '../../lib/highlight';
import { errorText, invoke } from '../../lib/ipc';
import { logError } from '../../lib/log';
import { HighlightedLines, useHighlight } from '../session/CodeBlock';

type DirState = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; entries: TreeEntryView[] };

/** Git status letter per path, plus "changed below" for folders. */
function useGitMarks(sessionId: string, refreshKey: unknown): { files: Map<string, string>; dirs: Set<string> } {
  const [marks, setMarks] = useState<{ files: Map<string, string>; dirs: Set<string> }>({ files: new Map(), dirs: new Set() });
  useEffect(() => {
    let cancelled = false;
    invoke('git:status', { sessionId })
      .then((status) => {
        if (cancelled) return;
        const files = new Map<string, string>();
        const dirs = new Set<string>();
        for (const f of status.files) {
          files.set(f.path, f.untracked ? 'U' : (f.unstaged ?? f.staged ?? 'M'));
          const parts = f.path.split('/');
          for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
        }
        setMarks({ files, dirs });
      })
      .catch((error: unknown) => logError('Could not read git status for the file tree', error));
    return () => {
      cancelled = true;
    };
  }, [sessionId, refreshKey]);
  return marks;
}

function TreeLevel({
  sessionId,
  dir,
  depth,
  marks,
  selected,
  onOpen,
  refreshKey
}: {
  sessionId: string;
  dir: string;
  depth: number;
  marks: { files: Map<string, string>; dirs: Set<string> };
  selected: string | null;
  onOpen: (path: string) => void;
  refreshKey: unknown;
}) {
  const [load, setLoad] = useState<DirState>({ state: 'loading' });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    invoke('files:list', { sessionId, dir })
      .then((entries) => {
        if (!cancelled) setLoad({ state: 'ready', entries });
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoad({ state: 'error', message: errorText(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, dir, refreshKey]);

  const pad = { paddingLeft: 6 + depth * 12 };
  if (load.state === 'loading') {
    return (
      <p className="py-2 text-sm text-fg-faint" style={pad}>
        Loading…
      </p>
    );
  }
  if (load.state === 'error') {
    return (
      <p role="alert" className="py-2 text-sm text-danger" style={pad}>
        {load.message}
      </p>
    );
  }
  if (load.entries.length === 0) {
    return (
      <p className="py-2 text-sm text-fg-faint" style={pad}>
        Empty folder
      </p>
    );
  }
  return (
    <ul role={depth === 0 ? 'tree' : 'group'} aria-label={depth === 0 ? 'Files' : undefined}>
      {load.entries.map((entry) => {
        const open = expanded.has(entry.path);
        const mark = entry.type === 'file' ? marks.files.get(entry.path) : marks.dirs.has(entry.path) ? '•' : undefined;
        return (
          <li key={entry.path} role="treeitem" aria-expanded={entry.type === 'dir' ? open : undefined} aria-selected={selected === entry.path}>
            <button
              type="button"
              onClick={() => {
                if (entry.type === 'dir') {
                  setExpanded((s) => {
                    const next = new Set(s);
                    if (next.has(entry.path)) next.delete(entry.path);
                    else next.add(entry.path);
                    return next;
                  });
                } else {
                  onOpen(entry.path);
                }
              }}
              className={cn('flex h-24 w-full items-center gap-6 rounded-sm pr-6 text-left text-base', selected === entry.path ? 'bg-selected text-fg-strong' : 'text-fg-secondary hover:bg-hover')}
              style={pad}
            >
              {entry.type === 'dir' ? (
                <>
                  <ChevronRight className={cn('size-12 shrink-0 text-icon-muted transition-transform', open && 'rotate-90')} aria-hidden="true" />
                  {open ? <FolderOpen className="size-14 shrink-0 text-icon" aria-hidden="true" /> : <Folder className="size-14 shrink-0 text-icon" aria-hidden="true" />}
                </>
              ) : (
                <>
                  <span className="size-12 shrink-0" aria-hidden="true" />
                  <File className="size-14 shrink-0 text-icon-muted" aria-hidden="true" />
                </>
              )}
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              {mark ? (
                <span className={cn('shrink-0 font-mono text-2xs', mark === 'D' ? 'text-diff-del' : mark === 'U' || mark === 'A' ? 'text-diff-add' : 'text-amber-fg')} title="Changed">
                  {mark}
                </span>
              ) : null}
            </button>
            {entry.type === 'dir' && open ? (
              <TreeLevel sessionId={sessionId} dir={entry.path} depth={depth + 1} marks={marks} selected={selected} onOpen={onOpen} refreshKey={refreshKey} />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

type Preview = { state: 'loading'; path: string } | { state: 'error'; path: string; message: string } | { state: 'ready'; preview: FilePreviewView };

function PreviewPane({ preview }: { preview: FilePreviewView }) {
  const language = useMemo(() => languageForPath(preview.path), [preview.path]);
  const lines = useHighlight(preview.content ?? '', language, preview.content !== null);
  if (preview.binary) return <p className="px-10 py-8 text-base text-fg-muted">Binary file ({Math.round(preview.size / 1024)} KB).</p>;
  if (preview.tooLarge) return <p className="px-10 py-8 text-base text-fg-muted">Too large to preview ({Math.round(preview.size / 1024)} KB).</p>;
  return (
    <pre className="selectable min-h-full px-10 py-8 font-mono text-[calc(var(--g-code-font-size)-1px)] leading-[1.5] text-fg">
      <code>
        <HighlightedLines code={preview.content ?? ''} lines={lines} />
      </code>
    </pre>
  );
}

/** Read-only file tree of the session folder with git status marks and a highlighted preview. */
export function FilesView({ sessionId, refreshKey }: { sessionId: string; refreshKey: unknown }) {
  const marks = useGitMarks(sessionId, refreshKey);
  const [preview, setPreview] = useState<Preview | null>(null);

  const open = (path: string): void => {
    setPreview({ state: 'loading', path });
    invoke('files:read', { sessionId, path })
      .then((p) => setPreview({ state: 'ready', preview: p }))
      .catch((error: unknown) => setPreview({ state: 'error', path, message: errorText(error) }));
  };

  const selected = preview ? (preview.state === 'ready' ? preview.preview.path : preview.path) : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={cn('min-h-0 overflow-y-auto p-4', preview ? 'max-h-[45%] shrink-0' : 'flex-1')}>
        <TreeLevel sessionId={sessionId} dir="" depth={0} marks={marks} selected={selected} onOpen={open} refreshKey={refreshKey} />
      </div>
      {preview ? (
        <div className="flex min-h-0 flex-1 flex-col border-t border-border-panel">
          <p className="flex h-24 shrink-0 items-center truncate px-10 font-mono text-2xs text-fg-muted">{selected}</p>
          <div className="min-h-0 flex-1 overflow-auto bg-code-block">
            {preview.state === 'loading' ? <LoadingState /> : null}
            {preview.state === 'error' ? <ErrorState message={preview.message} /> : null}
            {preview.state === 'ready' ? <PreviewPane preview={preview.preview} /> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
