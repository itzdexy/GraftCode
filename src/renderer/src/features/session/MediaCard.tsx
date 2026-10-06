import { Clapperboard, Download, ExternalLink, FileAudio, FileImage, FolderOpen, Sparkles } from 'lucide-react';
import type { MediaFile } from '@shared/schemas/toolDisplay';
import { IconButton } from '../../components/Button';
import { invoke } from '../../lib/ipc';
import { reportError, useToasts } from '../../stores/toasts';
import { fileSize } from './FilesCard';
import { fileName, type MadeMedia } from './transcriptModel';

function iconFor(file: MediaFile): typeof FileImage {
  if (file.kind === 'video' || file.kind === 'gif') return Clapperboard;
  if (file.kind === 'audio') return FileAudio;
  return FileImage;
}

/**
 * The pictures and clips a turn generated. Pictures show as previews; in a
 * chat each can be saved or opened, and in a code session each is shown in
 * the project folder it was written to.
 */
export function MediaCard({ sessionId, folder, media }: { sessionId: string; folder: string | null; media: MadeMedia }) {
  const { files } = media;
  const images = files.filter((f) => f.kind === 'image').length;
  const title =
    images === files.length ? (images === 1 ? 'Generated 1 image' : `Generated ${String(images)} images`) : files.length === 1 ? 'Generated 1 file' : `Generated ${String(files.length)} files`;

  const save = (name: string): void => {
    invoke('chatFiles:save', { sessionId, name })
      .then((saved) => {
        if (saved) useToasts.getState().push({ tone: 'success', title: `Saved ${name}`, description: saved });
      })
      .catch((error: unknown) => reportError(`Couldn't save ${name}`, error));
  };
  const open = (name: string): void => {
    invoke('chatFiles:open', { sessionId, name }).catch((error: unknown) => reportError(`Couldn't open ${name}`, error));
  };
  const reveal = (file: MediaFile): void => {
    const shown = folder ? invoke('app:revealPath', { path: `${folder}/${file.path}` }) : invoke('chatFiles:reveal', { sessionId, name: file.path });
    shown.catch((error: unknown) => reportError(`Couldn't show ${fileName(file.path)}`, error));
  };

  return (
    <section aria-label="Generated media" className="overflow-hidden rounded-md border border-border-card">
      <header className="flex h-30 items-center gap-8 border-b border-border-subtle px-12 text-md">
        <Sparkles className="size-13 shrink-0 text-accent" aria-hidden="true" />
        <span className="flex-1 font-medium text-fg-strong">{title}</span>
        <span className="truncate text-sm text-fg-faint">
          {media.model || media.engine}
          {media.costUsd !== null && media.costUsd > 0 ? ` · $${media.costUsd.toFixed(media.costUsd < 0.1 ? 3 : 2)}` : ''}
        </span>
      </header>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-8 p-8">
        {files.map((file) => {
          const Icon = iconFor(file);
          const name = fileName(file.path);
          return (
            <li key={file.path} className="group flex flex-col overflow-hidden rounded-sm border border-border-subtle bg-sunken">
              {file.thumb ? (
                <img src={`data:image/jpeg;base64,${file.thumb}`} alt={`Generated: ${name}`} className="motion-pop aspect-[4/3] w-full bg-code-block object-contain" />
              ) : (
                <div className="flex aspect-[4/3] w-full items-center justify-center text-icon-muted">
                  <Icon className="size-24" aria-hidden="true" />
                </div>
              )}
              <div className="flex h-28 items-center gap-4 pr-2 pl-8">
                <span className="min-w-0 flex-1 truncate text-sm text-fg" title={file.path}>
                  {name}
                </span>
                <span className="shrink-0 text-xs text-fg-faint">{fileSize(file.bytes)}</span>
                {folder ? null : (
                  <>
                    <IconButton label={`Save ${name}`} size="xs" onClick={() => save(file.path)}>
                      <Download className="size-13" />
                    </IconButton>
                    {file.kind === 'image' ? (
                      <IconButton label={`Open ${name}`} size="xs" onClick={() => open(file.path)}>
                        <ExternalLink className="size-13" />
                      </IconButton>
                    ) : null}
                  </>
                )}
                <IconButton label={`Show ${name} in its folder`} size="xs" onClick={() => reveal(file)}>
                  <FolderOpen className="size-13" />
                </IconButton>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
