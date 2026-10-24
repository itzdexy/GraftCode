import { useEffect } from 'react';
import { Box, FolderOpen, PanelRightOpen } from 'lucide-react';
import { Button } from '../../components/Button';
import { useFileRefs } from '../../stores/fileRefs';
import { usePanels } from '../../stores/panels';
import { useFileActions } from '../panels/FileMenu';
import { LazyModelViewer } from '../models/LazyModelViewer';

/** One model of the turn: drawn in 3D, with its name, and where to open it. */
function ModelRow({ sessionId, path }: { sessionId: string; path: string }) {
  const run = useFileActions(sessionId);
  const name = path.slice(path.lastIndexOf('/') + 1);
  return (
    <li aria-label={name} className="flex flex-col border-t border-border-subtle first:border-t-0">
      <LazyModelViewer sessionId={sessionId} path={path} variant="card" />
      <div className="flex min-h-36 flex-wrap items-center gap-x-4 gap-y-4 px-12 py-6">
        <div className="min-w-[120px] flex-1">
          <p className="truncate text-md font-medium text-fg-strong">{name}</p>
          <p className="selectable truncate font-mono text-2xs text-fg-muted" title={path}>
            {path}
          </p>
        </div>
        <Button size="sm" variant="ghost" leading={<PanelRightOpen className="size-12" />} onClick={() => usePanels.getState().openFile(sessionId, path)}>
          Open in Files
        </Button>
        <Button size="sm" variant="ghost" leading={<FolderOpen className="size-12" />} onClick={() => run('reveal', { path, type: 'file' })}>
          Show in folder
        </Button>
      </div>
    </li>
  );
}

/**
 * The 3D models a turn made or named, drawn where the turn ends: a model
 * exported from Blender shows up in the conversation, ready to turn around.
 * Names that are no file of the session's folder are left out.
 */
export function ModelsCard({ sessionId, paths }: { sessionId: string; paths: string[] }) {
  const known = useFileRefs((s) => s.known[sessionId]);
  useEffect(() => {
    for (const path of paths) useFileRefs.getState().ask(sessionId, path);
  }, [sessionId, paths]);
  const found = [...new Set(paths.map((path) => known?.[path]).filter((resolved): resolved is string => typeof resolved === 'string'))];
  if (found.length === 0) return null;
  return (
    <section aria-label="3D models from this turn" className="motion-rise overflow-hidden rounded-md border border-border-card">
      <header className="flex h-30 items-center gap-8 border-b border-border-subtle px-12 text-md">
        <Box className="size-13 shrink-0 text-icon" aria-hidden="true" />
        <span className="flex-1 font-medium text-fg-strong">{found.length === 1 ? '1 model' : `${String(found.length)} models`}</span>
        <span className="text-xs text-fg-faint">Drag to turn · scroll to zoom</span>
      </header>
      <ul className="flex flex-col">
        {found.map((path) => (
          <ModelRow key={path} sessionId={sessionId} path={path} />
        ))}
      </ul>
    </section>
  );
}
