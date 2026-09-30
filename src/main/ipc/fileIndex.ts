import path from 'node:path';
import { fuzzyFilter } from '@shared/fuzzy';
import { runFile } from '../tools/run';

const TTL_MS = 15_000;
const MAX_FILES = 200_000;

/** Project file lists (from ripgrep, .gitignore-aware) for fuzzy "@" mentions. */
export class FileIndex {
  private readonly cache = new Map<string, { at: number; files: string[] }>();
  private readonly inflight = new Map<string, Promise<string[]>>();

  constructor(private readonly rgPath: string) {}

  private async list(root: string): Promise<string[]> {
    const key = path.resolve(root);
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.files;
    const running = this.inflight.get(key);
    if (running) return running;
    const promise = runFile(this.rgPath, ['--files', '--hidden', '--no-config', '--glob', '!.git'], { cwd: key, timeoutMs: 30_000 })
      .then((r) => {
        const files = r.stdout
          .split(/\r?\n/)
          .filter((l) => l.length > 0)
          .slice(0, MAX_FILES)
          .map((f) => f.replace(/\\/g, '/'));
        this.cache.set(key, { at: Date.now(), files });
        return files;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  async search(root: string, query: string, limit = 50): Promise<string[]> {
    const files = await this.list(root);
    if (query.trim().length === 0) return files.slice(0, limit);
    return fuzzyFilter(query, files, (f) => f, limit);
  }
}
