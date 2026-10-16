import fs from 'node:fs';
import path from 'node:path';
import { fuzzyFilter } from '@shared/fuzzy';
import { isInside, isInsideReal } from '../tools/paths';
import { runFile } from '../tools/run';

const TTL_MS = 15_000;
const MAX_FILES = 200_000;

/** Project file lists (from ripgrep, .gitignore-aware) for fuzzy "@" mentions. */
export class FileIndex {
  private readonly cache = new Map<string, { at: number; files: string[] }>();
  private readonly inflight = new Map<string, Promise<string[]>>();
  /** Kept with the list it was made from, and gone when that list is. */
  private readonly names = new WeakMap<string[], Map<string, string[]>>();

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

  /** The listed files by their last part, so a name is matched against the few files that end with it. */
  private async byName(root: string): Promise<Map<string, string[]>> {
    const files = await this.list(root);
    let names = this.names.get(files);
    if (!names) {
      names = new Map();
      for (const file of files) {
        const name = file.slice(file.lastIndexOf('/') + 1);
        const same = names.get(name);
        if (same) same.push(file);
        else names.set(name, [file]);
      }
      this.names.set(files, names);
    }
    return names;
  }

  /**
   * The project file each written path names, or null when it names none or
   * more than one. A path that is a file inside `root` is itself (from the
   * root, or absolute); failing that it is the one listed file that ends with
   * it. Answers are from the root and use "/". `fresh` reads the list again
   * first, for files made since.
   */
  async resolve(root: string, paths: string[], fresh = false): Promise<Array<string | null>> {
    const key = path.resolve(root);
    if (fresh) this.cache.delete(key);
    let names: Promise<Map<string, string[]>> | null = null;
    return Promise.all(
      paths.map(async (written) => {
        const asked = written.replace(/\\/g, '/');
        const absolute = path.isAbsolute(asked);
        // An absolute path names one file. Outside the folder it names none here, whatever its last part is.
        if (absolute && !isInside(key, asked)) return null;
        const abs = path.resolve(key, asked);
        if (abs !== key && isInside(key, abs)) {
          const file = await fs.promises.stat(abs).then((stat) => stat.isFile(), () => false);
          // A link that leads out of the folder is outside it.
          if (file && isInsideReal(key, abs)) return path.relative(key, abs).split(path.sep).join('/');
        }
        if (absolute) return null;
        const rel = asked.replace(/^(?:\.\/)+/, '');
        const found = ((await (names ??= this.byName(key))).get(rel.slice(rel.lastIndexOf('/') + 1)) ?? []).filter((file) => file === rel || file.endsWith(`/${rel}`));
        return found.length === 1 ? (found[0] ?? null) : null;
      })
    );
  }
}
