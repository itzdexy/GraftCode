import { useMemo, useState } from 'react';
import { Code, FileText, FolderOpen, Image, LayoutTemplate, MessageSquareText, Shapes } from 'lucide-react';
import type { ArtifactView } from '@shared/schemas/workspace';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { cn } from '../../lib/cn';
import { relativeTime } from '../../lib/format';
import { languageForPath } from '../../lib/highlight';
import { invoke } from '../../lib/ipc';
import { useLoad } from '../../lib/useLoad';
import { useNav } from '../../stores/nav';
import { reportError } from '../../stores/toasts';
import { HighlightedLines, useHighlight } from '../session/CodeBlock';
import { Markdown } from '../session/Markdown';
import { PageLayout } from '../shell/PageLayout';

type Filter = 'all' | ArtifactView['kind'];

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'html', label: 'Pages' },
  { value: 'image', label: 'Images' },
  { value: 'markdown', label: 'Documents' },
  { value: 'code', label: 'Code' }
];

const ICONS: Record<ArtifactView['kind'], JSX.Element> = {
  html: <LayoutTemplate className="size-14" aria-hidden="true" />,
  image: <Image className="size-14" aria-hidden="true" />,
  markdown: <FileText className="size-14" aria-hidden="true" />,
  code: <Code className="size-14" aria-hidden="true" />,
  other: <Shapes className="size-14" aria-hidden="true" />
};

function TextPreview({ artifact }: { artifact: ArtifactView }) {
  const { load } = useLoad(() => invoke('artifacts:read', { path: artifact.path }), artifact.path);
  const content = load.status === 'ready' ? load.data.content : null;
  const lines = useHighlight(content ?? '', languageForPath(artifact.path), content !== null && artifact.kind === 'code');
  if (load.status === 'loading') return <LoadingState />;
  if (load.status === 'error') return <ErrorState message={load.message} />;
  if (load.data.binary) return <p className="p-16 text-base text-fg-muted">Binary file; no preview.</p>;
  if (load.data.tooLarge) return <p className="p-16 text-base text-fg-muted">Too large to preview.</p>;
  if (artifact.kind === 'markdown') return <Markdown text={content ?? ''} variant="code" className="p-16" />;
  return (
    <pre className="selectable p-12 font-mono text-[calc(var(--g-code-font-size)-1px)] leading-[1.5] text-fg">
      <code>
        <HighlightedLines code={content ?? ''} lines={lines} />
      </code>
    </pre>
  );
}

function FramePreview({ artifact }: { artifact: ArtifactView }) {
  const { load } = useLoad(() => invoke('artifacts:previewUrl', { path: artifact.path }), artifact.path);
  if (load.status === 'loading') return <LoadingState />;
  if (load.status === 'error') return <ErrorState message={load.message} />;
  if (artifact.kind === 'image') {
    return (
      <div className="flex h-full items-center justify-center p-16">
        <img src={load.data.url} alt={artifact.name} className="max-h-full max-w-full object-contain" />
      </div>
    );
  }
  return (
    <iframe
      title={`Preview of ${artifact.name}`}
      src={load.data.url}
      // Scripts run in an opaque origin with no network (see ARTIFACT_CSP in main).
      sandbox="allow-scripts"
      className="h-full w-full border-0 bg-white"
    />
  );
}

function Preview({ artifact }: { artifact: ArtifactView }) {
  if (!artifact.exists) return <EmptyState title="File not found" description="It was moved or deleted after the session." />;
  if (artifact.kind === 'html' || artifact.kind === 'image') return <FramePreview key={artifact.path} artifact={artifact} />;
  if (artifact.kind === 'other') return <EmptyState title="No preview" description="Open the folder to see this file." />;
  return <TextPreview key={artifact.path} artifact={artifact} />;
}

/** Files the agent created or edited, with sandboxed previews. */
export function ArtifactsView() {
  const { load, reload } = useLoad(() => invoke('artifacts:list'), 'artifacts');
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const list = useMemo(() => (load.status === 'ready' ? load.data.filter((a) => filter === 'all' || a.kind === filter) : []), [load, filter]);
  const current = list.find((a) => a.path === selected) ?? list[0] ?? null;

  return (
    <PageLayout title="Artifacts" description="Files Graft created or edited in your sessions." wide actions={<Button variant="ghost" onClick={reload}>Refresh</Button>}>
      <div role="radiogroup" aria-label="Show" className="mb-12 flex flex-wrap gap-6">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            role="radio"
            aria-checked={filter === f.value}
            onClick={() => setFilter(f.value)}
            className={cn('h-24 rounded-full border px-10 text-sm', filter === f.value ? 'border-border-strong bg-hover text-fg' : 'border-border text-fg-muted hover:text-fg-secondary')}
          >
            {f.label}
          </button>
        ))}
      </div>
      {load.status === 'loading' ? <LoadingState /> : null}
      {load.status === 'error' ? <ErrorState message={load.message} onRetry={reload} /> : null}
      {load.status === 'ready' && list.length === 0 ? (
        <EmptyState icon={<Shapes className="size-20" />} title="No artifacts yet" description="When the agent writes files in a session, they show up here." />
      ) : null}
      {list.length > 0 && current ? (
        <div className="grid h-[calc(100vh-220px)] min-h-[360px] grid-cols-[minmax(220px,320px)_1fr] gap-12">
          <ul aria-label="Artifacts" className="min-h-0 overflow-y-auto rounded-md border border-border-panel bg-sunken p-4">
            {list.map((a) => (
              <li key={a.path}>
                <button
                  type="button"
                  onClick={() => setSelected(a.path)}
                  aria-current={a.path === current.path ? 'true' : undefined}
                  className={cn('flex w-full items-start gap-8 rounded-sm px-8 py-6 text-left', a.path === current.path ? 'bg-selected' : 'hover:bg-hover')}
                >
                  <span className="mt-2 text-icon">{ICONS[a.kind]}</span>
                  <span className="min-w-0 flex-1">
                    <span className={cn('block truncate text-base', a.exists ? 'text-fg' : 'text-fg-faint line-through')}>{a.name}</span>
                    <span className="block truncate text-2xs text-fg-muted">
                      {a.sessionTitle} · {relativeTime(a.updatedAt)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <section aria-label="Preview" className="flex min-h-0 flex-col overflow-hidden rounded-md border border-border-panel bg-surface">
            <header className="flex h-36 shrink-0 items-center gap-8 border-b border-border-panel px-12">
              <span className="min-w-0 flex-1 truncate font-mono text-sm text-fg-secondary" title={current.path}>
                {current.path}
              </span>
              {current.created ? <Badge>New file</Badge> : <Badge>Edited</Badge>}
              <Button size="sm" variant="ghost" leading={<MessageSquareText className="size-14" />} onClick={() => useNav.getState().go({ name: 'session', id: current.sessionId })}>
                Session
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!current.exists}
                leading={<FolderOpen className="size-14" />}
                onClick={() => invoke('app:revealPath', { path: current.path }).catch((e: unknown) => reportError("Couldn't show the file", e))}
              >
                Show
              </Button>
            </header>
            <div className="min-h-0 flex-1 overflow-auto">
              <Preview artifact={current} />
            </div>
          </section>
        </div>
      ) : null}
    </PageLayout>
  );
}
