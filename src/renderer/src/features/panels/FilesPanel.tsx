import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronRight, Code, Copy, File, FileImage, Folder, FolderOpen, Image, Maximize, Minimize, Pencil, Save, X } from 'lucide-react';
import type { TreeEntryView, FilePreviewView } from '@shared/schemas/panels';
import type { CodeLocation } from '@shared/schemas/semantic';
import { Button, IconButton } from '../../components/Button';
import { ErrorState, LoadingState } from '../../components/States';
import { cn } from '../../lib/cn';
import { languageForPath } from '../../lib/highlight';
import { errorText, invoke } from '../../lib/ipc';
import { logError } from '../../lib/log';
import { useLoad } from '../../lib/useLoad';
import { HighlightedLines, useHighlight } from '../session/CodeBlock';
import { previewNote } from './fileActions';
import { FileMenu, useFileActions } from './FileMenu';
import { draftSaves, type SaveTarget } from './draftSaves';
import { useEditorDrafts } from './editorDrafts';
import { flushEditorRecovery, recoverEditorDrafts } from './editorRecovery';
import { closeWorkspaceTab, loadWorkspaceLayout, openWorkspaceTab, saveWorkspaceLayout, setWorkspaceTabMode, type WorkspaceTab } from './workspaceLayout';

const TextEditor = lazy(() => import('./TextEditor'));

/** Files the tree marks as pictures or clips, by name (the preview itself asks the main process). */
const LOOKS_LIKE_MEDIA = /\.(png|jpe?g|gif|webp|bmp|ico|avif|svg|mp4|webm)$/i;

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
  /** The row whose menu is open (a right-click opens it too). */
  const [menuFor, setMenuFor] = useState<string | null>(null);

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
            <div
              className="group/row relative"
              onContextMenu={(event) => {
                event.preventDefault();
                setMenuFor(entry.path);
              }}
            >
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
                    {LOOKS_LIKE_MEDIA.test(entry.name) ? <FileImage className="size-14 shrink-0 text-icon-muted" aria-hidden="true" /> : <File className="size-14 shrink-0 text-icon-muted" aria-hidden="true" />}
                  </>
                )}
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                {mark ? (
                  <span className={cn('shrink-0 font-mono text-2xs', mark === 'D' ? 'text-diff-del' : mark === 'U' || mark === 'A' ? 'text-diff-add' : 'text-amber-fg')} title="Changed">
                    {mark}
                  </span>
                ) : null}
              </button>
              {/* Shown on hover and focus, and while its menu is open; it sits over the change mark. */}
              <FileMenu
                sessionId={sessionId}
                target={{ path: entry.path, type: entry.type }}
                open={menuFor === entry.path}
                onOpenChange={(next) => setMenuFor(next ? entry.path : null)}
                className={cn(
                  'absolute top-2 right-2 bg-sunken opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100',
                  menuFor === entry.path && 'opacity-100'
                )}
              />
            </div>
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

interface Pixels {
  width: number;
  height: number;
}

/** A picture, clip or sound from the session's folder, loaded through an address that serves that one file. */
function MediaPreview({ sessionId, preview, opened, fit, onPixels }: { sessionId: string; preview: FilePreviewView; opened: number; fit: boolean; onPixels: (pixels: Pixels) => void }) {
  // `opened` counts the clicks on the file, so opening it again loads it again (it may have been made anew).
  const { load } = useLoad(() => invoke('files:previewUrl', { sessionId, path: preview.path }), `${preview.path}:${String(preview.size)}:${String(opened)}`);
  if (load.status === 'loading') return <LoadingState />;
  if (load.status === 'error') return <ErrorState message={load.message} />;
  const name = preview.path.slice(preview.path.lastIndexOf('/') + 1);
  if (preview.media === 'video') {
    return (
      <div className="flex h-full items-center justify-center p-12">
        <video key={load.data.url} src={load.data.url} controls className="max-h-full max-w-full rounded-sm" aria-label={`Preview of ${name}`} />
      </div>
    );
  }
  if (preview.media === 'audio') {
    return (
      <div className="flex h-full items-center justify-center p-12">
        <audio key={load.data.url} src={load.data.url} controls aria-label={`Preview of ${name}`} />
      </div>
    );
  }
  return (
    <div className={cn('graft-checker flex items-center justify-center p-12', fit ? 'h-full' : 'min-h-full min-w-max')}>
      <img
        src={load.data.url}
        alt={`Preview of ${name}`}
        draggable={false}
        onLoad={(event) => onPixels({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        className={cn('motion-pop', fit ? 'max-h-full max-w-full object-contain' : 'max-w-none')}
      />
    </div>
  );
}

function PreviewPane({ sessionId, preview, opened, fit, source, onPixels }: { sessionId: string; preview: FilePreviewView; opened: number; fit: boolean; source: boolean; onPixels: (pixels: Pixels) => void }) {
  const language = useMemo(() => languageForPath(preview.path), [preview.path]);
  const lines = useHighlight(preview.content ?? '', language, preview.content !== null);
  if (preview.tooLarge) return <p className="px-10 py-8 text-base text-fg-muted">Too large to preview ({Math.round(preview.size / 1024)} KB). Show it in its folder to open it.</p>;
  if (preview.media && !(source && preview.content !== null)) return <MediaPreview sessionId={sessionId} preview={preview} opened={opened} fit={fit} onPixels={onPixels} />;
  if (preview.binary) return <p className="px-10 py-8 text-base text-fg-muted">Binary file ({Math.round(preview.size / 1024)} KB).</p>;
  return (
    <pre className="selectable min-h-full px-10 py-8 font-mono text-[calc(var(--g-code-font-size)-1px)] leading-[1.5] text-fg">
      <code>
        <HighlightedLines code={preview.content ?? ''} lines={lines} />
      </code>
    </pre>
  );
}

/** How the previewed picture is shown; it starts over with each file. */
interface ViewState {
  path: string;
  /** Scaled to fit the panel, or at its own size with scrolling. */
  fit: boolean;
  /** An SVG's source instead of the picture. */
  source: boolean;
  pixels: Pixels | null;
}

/** File tree of the session folder with git status marks, a preview (text, pictures, clips) and each file's actions. */
export function FilesView({ sessionId, refreshKey }: { sessionId: string; refreshKey: unknown }) {
  const [restoredLayout] = useState(() => loadWorkspaceLayout(sessionId));
  const [layout, setLayout] = useState(restoredLayout);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => { saveWorkspaceLayout(sessionId, layout); }, [sessionId, layout]);
  const [recoveredSession, setRecoveredSession] = useState<string | null>(null);
  const [recoveryFailure, setRecoveryFailure] = useState<{ sessionId: string; message: string } | null>(null);
  const recovered = recoveredSession === sessionId;
  const recoveryError = recoveryFailure?.sessionId === sessionId ? recoveryFailure.message : null;
  const [saved, setSaved] = useState(0);
  const treeRefresh = useMemo(() => [refreshKey, saved], [refreshKey, saved]);
  const marks = useGitMarks(sessionId, treeRefresh);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [opened, setOpened] = useState(0);
  const [view, setView] = useState<ViewState | null>(null);
  const run = useFileActions(sessionId);
  const request = useRef(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const saver = useRef<((target: SaveTarget) => void) | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [position, setPosition] = useState<CodeLocation | null>(null);

  const open = useCallback((path: string, location: CodeLocation | null = null, recovery = false, mode: WorkspaceTab['mode'] = 'preview'): void => {
    const requestedMode = location || recovery ? 'edit' : mode;
    setLayout((current) => openWorkspaceTab(current, path, requestedMode));
    const next = ++request.current;
    setPreview({ state: 'loading', path });
    setOpened((n) => n + 1);
    setEditing(null);
    setSaveError(null);
    setPosition(location);
    invoke('files:read', { sessionId, path })
      .then((p) => {
        if (next !== request.current) return;
        const restored = useEditorDrafts.getState().drafts[`${sessionId}:${path}`];
        if (recovery && restored && (!p.revision || p.content === null)) {
          setPreview({ state: 'ready', preview: { path, content: restored.original, revision: restored.revision, media: null, size: restored.original.length, binary: false, tooLarge: false } });
          setEditing(`${sessionId}:${path}`); setSaveError('The current file cannot be edited as UTF-8 text. Your recovered draft is kept and can be copied.');
          return;
        }
        setPreview({ state: 'ready', preview: p });
        if (requestedMode === 'edit' && p.revision && p.content !== null) {
          const key = `${sessionId}:${path}`;
          useEditorDrafts.getState().open(key, p); setEditing(key);
        }
      })
      .catch((error: unknown) => {
        if (next !== request.current) return;
        const key = `${sessionId}:${path}`, savedDraft = useEditorDrafts.getState().drafts[key];
        if (recovery && savedDraft) {
          setPreview({ state: 'ready', preview: { path, content: savedDraft.original, revision: savedDraft.revision, media: null, size: savedDraft.original.length, binary: false, tooLarge: false } });
          setEditing(key); setSaveError(`${errorText(error)} Your recovered draft is kept; copy its text if the original file was removed.`);
        } else setPreview({ state: 'error', path, message: errorText(error) });
      });
  }, [sessionId]);

  // Draft hydration comes first so a restored edit tab keeps its original revision.
  useEffect(() => {
    let active = true;
    void recoverEditorDrafts(sessionId).catch((error: unknown) => { if (active) setRecoveryFailure({ sessionId, message: errorText(error) }); })
      .finally(() => {
        if (!active) return;
        setRecoveredSession(sessionId);
        const tab = restoredLayout.tabs.find((item) => item.path === restoredLayout.activePath);
        if (tab) {
          const previous = useEditorDrafts.getState().drafts[`${sessionId}:${tab.path}`];
          open(tab.path, null, !!previous && previous.content !== previous.original && tab.mode === 'edit', tab.mode);
        }
      });
    return () => { active = false; void flushEditorRecovery(sessionId); };
  }, [restoredLayout, sessionId, open]);

  const activateTab = (tab: WorkspaceTab): void => {
    const previous = useEditorDrafts.getState().drafts[`${sessionId}:${tab.path}`];
    open(tab.path, null, !!previous && previous.content !== previous.original && tab.mode === 'edit', tab.mode);
  };
  const closeTab = (path: string): void => {
    const next = closeWorkspaceTab(layout, path);
    setLayout(next);
    // Closing a view never discards a draft or bypasses its separate recovery writes.
    void flushEditorRecovery(sessionId);
    if (layout.activePath !== path) return;
    const adjacent = next.tabs.find((tab) => tab.path === next.activePath);
    if (adjacent) { activateTab(adjacent); requestAnimationFrame(() => tabRefs.current.get(adjacent.path)?.focus()); }
    else { request.current++; setPreview(null); setEditing(null); setSaveError(null); setPosition(null); }
  };
  const navigateTabs = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (event.key === 'Delete') { event.preventDefault(); const tab = layout.tabs[index]; if (tab) closeTab(tab.path); return; }
    const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? layout.tabs.length - 1 : direction ? (index + direction + layout.tabs.length) % layout.tabs.length : -1;
    const tab = layout.tabs[nextIndex];
    if (!tab) return;
    event.preventDefault(); activateTab(tab); tabRefs.current.get(tab.path)?.focus();
  };

  const selected = preview ? (preview.state === 'ready' ? preview.preview.path : preview.path) : null;
  const ready = preview?.state === 'ready' ? preview.preview : null;
  const draftKey = `${sessionId}:${selected ?? ''}`;
  const draft = useEditorDrafts((s) => s.drafts[draftKey]);
  const recovery = useEditorDrafts((s) => s.recovery[draftKey]);
  const drafts = useEditorDrafts((s) => s.drafts);
  const recoveryPaths = Object.entries(drafts).filter(([key, value]) => key.startsWith(`${sessionId}:`) && value.content !== value.original).map(([key]) => key.slice(sessionId.length + 1));
  const edit = editing === draftKey && !!draft && !!ready;
  const dirty = !!draft && draft.content !== draft.original;
  // Ctrl+S reaches this before React has drawn the last keystrokes, or the end of the save before:
  // the draft and whether a save is running are read where they live (draftSaves), not from this render.
  // Made on the first save and kept: this view is mounted once for a session, so sessionId stays the same.
  const save = (): void => {
    if (!selected) return;
    saver.current ??= draftSaves({
      write: (target, content, revision) => invoke('files:save', { sessionId, path: target.path, content, revision }),
      started: () => { setSaving(true); setSaveError(null); },
      saved: (target, result) => { if (target.view === request.current) setPreview({ state: 'ready', preview: result }); setSaved((n) => n + 1); },
      failed: (target, error) => { if (target.view === request.current) setSaveError(errorText(error)); },
      settled: () => setSaving(false)
    });
    saver.current({ key: draftKey, path: selected, view: request.current });
  };
  const shown: ViewState = view && view.path === selected ? view : { path: selected ?? '', fit: true, source: false, pixels: null };
  const picture = ready?.media === 'image' && !ready.tooLarge;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {recoveryError ? <p role="alert" className="px-10 py-6 text-sm text-danger">{recoveryError}</p> : null}
      {recovered && recoveryPaths.length ? <div aria-label="Unsaved drafts" className="max-h-[20%] shrink-0 overflow-auto border-b border-border px-8 py-4">
        <p className="text-2xs text-fg-muted">Unsaved drafts</p>
        {recoveryPaths.map((path) => <button key={path} aria-label={`Open draft ${path}`} className="block w-full truncate py-4 text-left font-mono text-2xs text-fg-muted hover:text-fg" onClick={() => open(path, null, true)}>{path}</button>)}
      </div> : null}
      <div className={cn('min-h-0 overflow-y-auto p-4', preview ? 'max-h-[45%] shrink-0' : 'flex-1')}>
        {recovered ? <TreeLevel sessionId={sessionId} dir="" depth={0} marks={marks} selected={selected} onOpen={open} refreshKey={refreshKey} /> : <LoadingState label="Recovering editor drafts…" />}
      </div>
      {preview && selected !== null ? (
        <div className="flex min-h-0 flex-1 flex-col border-t border-border-panel">
          <div role="tablist" aria-label="Open files" className="flex shrink-0 overflow-x-auto border-b border-border bg-sunken px-4 pt-3">
            {layout.tabs.map((tab, index) => {
              const current = tab.path === selected;
              const buffer = drafts[`${sessionId}:${tab.path}`];
              const unsaved = !!buffer && buffer.content !== buffer.original;
              return <div key={tab.path} role="presentation" className={cn('motion-step flex min-w-0 shrink-0 items-center rounded-t-sm border-b-2', current ? 'border-accent bg-code-block' : 'border-transparent hover:bg-hover')}>
                <button type="button" role="tab" id={`file-tab-${sessionId}-${index}`} aria-selected={current} aria-controls={`file-pane-${sessionId}`}
                  aria-label={`${tab.path}${unsaved ? ' (unsaved changes)' : ''}`} tabIndex={current ? 0 : -1} title={tab.path}
                  ref={(button) => { if (button) tabRefs.current.set(tab.path, button); else tabRefs.current.delete(tab.path); }}
                  onClick={() => activateTab(tab)} onKeyDown={(event) => navigateTabs(event, index)}
                  className={cn('flex h-28 max-w-[180px] items-center gap-6 px-8 text-xs transition-ui', current ? 'text-fg' : 'text-fg-muted')}>
                  <File className="size-12 shrink-0" aria-hidden="true" /><span className="truncate">{tab.path.slice(tab.path.lastIndexOf('/') + 1)}</span>
                  {unsaved ? <span className="size-5 shrink-0 rounded-full bg-amber" aria-hidden="true" /> : null}
                </button>
                <IconButton label={`Close tab ${tab.path}`} size="xs" tooltip={false} onClick={() => closeTab(tab.path)} className="mr-3"><X className="size-12" /></IconButton>
              </div>;
            })}
          </div>
          <div role="tabpanel" id={`file-pane-${sessionId}`} aria-labelledby={`file-tab-${sessionId}-${layout.tabs.findIndex((tab) => tab.path === selected)}`} className="flex min-h-0 flex-1 flex-col">
          <div className="flex h-28 shrink-0 items-center gap-2 pr-4 pl-10">
            <p className="selectable min-w-0 flex-1 truncate font-mono text-2xs text-fg-muted" title={selected}>
              {selected}
            </p>
            {ready ? <span className="shrink-0 px-4 text-2xs text-fg-faint tabular-nums">{previewNote(ready, shown.pixels)}</span> : null}
            {dirty ? <span className="text-2xs text-amber-fg" aria-label="Unsaved changes">Unsaved</span> : null}
            {ready?.revision && ready.content !== null ? <IconButton label={edit ? 'Preview file' : 'Edit file'} size="xs" active={edit} onClick={() => {
              if (edit) { setEditing(null); setLayout((current) => setWorkspaceTabMode(current, selected, 'preview')); }
              else { useEditorDrafts.getState().open(draftKey, ready); setEditing(draftKey); setLayout((current) => setWorkspaceTabMode(current, selected, 'edit')); }
            }}><Pencil className="size-13" /></IconButton> : null}
            {edit ? <IconButton label={saving ? 'Saving file' : 'Save file'} shortcut="Ctrl+S" size="xs" disabled={saving || !dirty} onClick={save}><Save className="size-13" /></IconButton> : null}
            {picture && ready.content !== null ? (
              <IconButton label={shown.source ? 'Show the picture' : 'Show the source'} size="xs" active={shown.source} onClick={() => setView({ ...shown, source: !shown.source })}>
                {shown.source ? <Image className="size-13" /> : <Code className="size-13" />}
              </IconButton>
            ) : null}
            {picture && !shown.source ? (
              <IconButton label={shown.fit ? 'Actual size' : 'Fit to panel'} size="xs" onClick={() => setView({ ...shown, fit: !shown.fit })}>
                {shown.fit ? <Maximize className="size-13" /> : <Minimize className="size-13" />}
              </IconButton>
            ) : null}
            <IconButton label="Copy path" size="xs" onClick={() => run('copy-path', { path: selected, type: 'file' })}>
              <Copy className="size-13" />
            </IconButton>
            <IconButton label="Show in folder" size="xs" onClick={() => run('reveal', { path: selected, type: 'file' })}>
              <FolderOpen className="size-13" />
            </IconButton>
            <FileMenu sessionId={sessionId} target={{ path: selected, type: 'file' }} />
          </div>
          {saveError ? <div role="alert" className="flex shrink-0 flex-wrap items-center gap-6 border-t border-border px-10 py-6">
            <p className="flex-1 text-sm text-danger">{saveError}</p>
            <Button size="xs" variant="ghost" onClick={() => { useEditorDrafts.getState().discard(draftKey); setEditing(null); open(selected); }}>Discard draft and reload</Button>
          </div> : null}
          {dirty ? <p role={recovery?.state === 'error' ? 'alert' : 'status'} className="shrink-0 px-10 py-4 text-2xs text-fg-muted">
            {recovery?.state === 'error' ? `Draft recovery failed: ${recovery.message ?? 'unknown error'}. Your draft remains in memory.` : recovery?.state === 'backed-up' ? 'Draft backed up on this device.' : 'Backing up draft…'}
          </p> : null}
          <div className="min-h-0 flex-1 overflow-auto bg-code-block">
            {preview.state === 'loading' ? <LoadingState /> : null}
            {preview.state === 'error' ? <ErrorState message={preview.message} /> : null}
            {edit && draft ? <Suspense fallback={<LoadingState label="Loading editor…" />}><TextEditor key={`${sessionId}:${selected}:${opened}`} sessionId={sessionId} file={selected} value={draft.content} position={position} onNavigate={(location) => open(location.file, location)}
              onChange={(content) => useEditorDrafts.getState().change(draftKey, content)} onSave={save} /></Suspense> : ready ? (
              <PreviewPane sessionId={sessionId} preview={ready} opened={opened} fit={shown.fit} source={shown.source} onPixels={(pixels) => setView({ ...shown, pixels })} />
            ) : null}
          </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
