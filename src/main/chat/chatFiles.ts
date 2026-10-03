import fs from 'node:fs';
import path from 'node:path';
import { GraftError } from '@shared/errors';

/**
 * Files a chat makes for the user to download (CreateFile, and files that
 * RunCode writes). Each chat keeps its own folder in the app's data folder;
 * names are reduced to a plain file name, so nothing lands outside it, and a
 * new file never replaces an earlier one.
 */
export interface ChatFile {
  name: string;
  /** Absolute path in the app's data folder. */
  path: string;
  size: number;
  mime: string;
}

export const MAX_CHAT_FILE_BYTES = 25 * 1024 * 1024;
const MAX_CHAT_BYTES = 250 * 1024 * 1024;

const MIME: Record<string, string> = {
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.xml': 'application/xml',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.js': 'text/javascript',
  '.ts': 'text/plain',
  '.py': 'text/x-python'
};

export function mimeOf(name: string): string {
  return MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

/** Whether a click may open the file in its viewer (see @shared/chatFileTypes). */
export { canOpenChatFile as canOpen } from '@shared/chatFileTypes';

/** A plain file name: no folders, no characters Windows refuses, no reserved device names. */
export function safeFileName(name: string): string {
  const base = (name.replace(/\\/g, '/').split('/').pop() ?? '').normalize('NFC');
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0, 120);
  const file = cleaned || 'file.txt';
  return /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(file) ? `_${file}` : file;
}

export class ChatFiles {
  constructor(private readonly root: string) {}

  private dir(sessionId: string): string {
    return path.join(this.root, sessionId.replace(/[^A-Za-z0-9_-]/g, '_'));
  }

  private used(dir: string): number {
    let total = 0;
    for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
      if (entry.isFile()) total += fs.statSync(path.join(dir, entry.name)).size;
    }
    return total;
  }

  /** Saves a file, naming it "report (2).csv" instead of replacing an earlier "report.csv". */
  save(sessionId: string, name: string, data: Buffer): ChatFile {
    if (data.length > MAX_CHAT_FILE_BYTES) throw new GraftError('file_too_large', `Files can be up to ${String(MAX_CHAT_FILE_BYTES / 1024 / 1024)} MB.`);
    const dir = this.dir(sessionId);
    fs.mkdirSync(dir, { recursive: true });
    if (this.used(dir) + data.length > MAX_CHAT_BYTES) throw new GraftError('chat_files_full', 'This chat has used its 250 MB of file space. Start a new chat for more files.');
    const wanted = safeFileName(name);
    const ext = path.extname(wanted);
    const stem = wanted.slice(0, wanted.length - ext.length);
    let final = wanted;
    for (let n = 2; fs.existsSync(path.join(dir, final)); n++) final = `${stem} (${String(n)})${ext}`;
    const target = path.join(dir, final);
    fs.writeFileSync(target, data, { flag: 'wx' });
    return { name: final, path: target, size: data.length, mime: mimeOf(final) };
  }

  /** Where a chat's file is stored, or null when there is no such file. */
  find(sessionId: string, name: string): string | null {
    if (safeFileName(name) !== name) return null;
    const target = path.join(this.dir(sessionId), name);
    return fs.existsSync(target) && fs.statSync(target).isFile() ? target : null;
  }

  deleteForSession(sessionId: string): void {
    fs.rmSync(this.dir(sessionId), { recursive: true, force: true });
  }

  deleteAll(): void {
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}
