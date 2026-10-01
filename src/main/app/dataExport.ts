import fs from 'node:fs';
import type { StoredMessage } from '@shared/schemas/messages';
import type { SessionSummary } from '@shared/schemas/sessions';

export interface ExportSource {
  version: string;
  settings: unknown;
  /** Provider summaries: kind, label, base URL and custom models. Keys are never exported. */
  providers: unknown[];
  projects: unknown[];
  schedules: unknown[];
  sessions(): SessionSummary[];
  messages(sessionId: string): StoredMessage[];
}

/**
 * Streams everything Graft keeps about the user's work (settings, projects,
 * schedules, every saved session with its messages) into one JSON file.
 * Written beside the target and renamed into place, so a failed export never
 * leaves a truncated file. Returns the number of sessions written.
 */
export async function writeExport(file: string, source: ExportSource): Promise<number> {
  const partial = `${file}.partial`;
  const out = fs.createWriteStream(partial, { encoding: 'utf8' });
  const write = (chunk: string): Promise<void> =>
    new Promise((resolve, reject) => {
      out.write(chunk, (error) => (error ? reject(error) : resolve()));
    });
  let count = 0;
  try {
    await write(`{\n  "format": "graft-export",\n  "formatVersion": 1,\n  "exportedAt": ${JSON.stringify(new Date().toISOString())},\n`);
    await write(`  "appVersion": ${JSON.stringify(source.version)},\n`);
    await write(`  "settings": ${JSON.stringify(source.settings)},\n`);
    await write(`  "providers": ${JSON.stringify(source.providers)},\n`);
    await write(`  "projects": ${JSON.stringify(source.projects)},\n`);
    await write(`  "schedules": ${JSON.stringify(source.schedules)},\n`);
    await write('  "sessions": [');
    for (const session of source.sessions()) {
      if (session.incognito) continue;
      await write(`${count > 0 ? ',' : ''}\n    ${JSON.stringify({ ...session, messages: source.messages(session.id) })}`);
      count++;
    }
    await write('\n  ]\n}\n');
    await new Promise<void>((resolve, reject) => {
      out.end((error?: Error | null) => (error ? reject(error) : resolve()));
    });
    await fs.promises.rename(partial, file);
    return count;
  } catch (error) {
    out.destroy();
    await fs.promises.rm(partial, { force: true });
    throw error;
  }
}
