import { Download, ExternalLink, FileCode2, FileImage, FileSpreadsheet, FileText, FolderOpen, Globe, Paperclip, Presentation } from 'lucide-react';
import type { MadeFile } from '@shared/schemas/toolDisplay';
import { canOpenChatFile } from '@shared/chatFileTypes';
import { IconButton } from '../../components/Button';
import { fileSize } from '../../lib/format';
import { invoke } from '../../lib/ipc';
import { reportError, useToasts } from '../../stores/toasts';
import { fileGlyph, type FileGlyph } from './fileCardModel';

export { fileSize };

const ICONS: Record<FileGlyph, typeof FileText> = {
  image: FileImage,
  sheet: FileSpreadsheet,
  slides: Presentation,
  web: Globe,
  code: FileCode2,
  document: FileText,
  text: FileText
};

async function save(sessionId: string, name: string): Promise<void> {
  try {
    const saved = await invoke('chatFiles:save', { sessionId, name });
    if (saved) useToasts.getState().push({ tone: 'success', title: `Saved ${name}`, description: saved });
  } catch (error) {
    reportError(`Couldn't save ${name}`, error);
  }
}

function act(channel: 'chatFiles:open' | 'chatFiles:reveal', sessionId: string, name: string): void {
  invoke(channel, { sessionId, name }).catch((error: unknown) => reportError(`Couldn't open ${name}`, error));
}

/** The files a chat reply made for the user, each with Save, Open and Show in folder. */
export function FilesCard({ sessionId, files }: { sessionId: string; files: MadeFile[] }) {
  return (
    <section aria-label="Files from this reply" className="overflow-hidden rounded-md border border-border-card">
      <header className="flex h-30 items-center gap-8 border-b border-border-subtle px-12 text-md">
        <Paperclip className="size-13 shrink-0 text-icon" aria-hidden="true" />
        <span className="flex-1 font-medium text-fg-strong">{files.length === 1 ? '1 file' : `${String(files.length)} files`}</span>
      </header>
      <ul className="flex flex-col py-2">
        {files.map((file) => {
          const Icon = ICONS[fileGlyph(file)];
          return (
            <li key={file.name} className="group flex h-32 items-center gap-8 px-12 text-md transition-ui hover:bg-hover">
              <Icon className="size-14 shrink-0 text-icon-muted" aria-hidden="true" />
              <button type="button" className="min-w-0 flex-1 truncate text-left font-medium text-fg hover:underline" title={`Save ${file.name}`} onClick={() => void save(sessionId, file.name)}>
                {file.name}
              </button>
              <span className="shrink-0 text-sm text-fg-faint">{fileSize(file.size)}</span>
              <IconButton label={`Save ${file.name}`} size="xs" onClick={() => void save(sessionId, file.name)}>
                <Download className="size-13" />
              </IconButton>
              {canOpenChatFile(file.name) ? (
                <IconButton label={`Open ${file.name}`} size="xs" onClick={() => act('chatFiles:open', sessionId, file.name)}>
                  <ExternalLink className="size-13" />
                </IconButton>
              ) : null}
              <IconButton label={`Show ${file.name} in its folder`} size="xs" onClick={() => act('chatFiles:reveal', sessionId, file.name)}>
                <FolderOpen className="size-13" />
              </IconButton>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
