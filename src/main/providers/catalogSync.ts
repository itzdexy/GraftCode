import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { CatalogSyncStatus } from '@shared/schemas/catalogSync';
import { redact } from '../app/log';
import { CatalogDataSchema, decodeModelsDev, reconcileCatalog } from './catalogData';
import type { ProviderCatalog } from './presets';

export const CATALOG_SOURCE = 'https://models.dev/api.json' as const;
const MAX_BYTES = 32 * 1024 * 1024;
const NO_CHANGES = { added: 0, changed: 0, omitted: 0, deprecated: 0 };
const SnapshotSchema = z.object({
  version: z.literal(1), source: z.literal(CATALOG_SOURCE),
  fetchedAt: z.number().int().nonnegative(), verifiedAt: z.number().int().nonnegative(),
  etag: z.string().max(4096).nullable(), lastModified: z.string().max(4096).nullable(),
  catalog: CatalogDataSchema
});
type Snapshot = z.infer<typeof SnapshotSchema>;

export interface CatalogSyncOptions {
  file: string;
  catalog: ProviderCatalog;
  fetch?: typeof fetch;
  now?: () => number;
  changed?: (status: CatalogSyncStatus) => void;
  log?: (message: string) => void;
}

/** Independent of app updates. Only metadata is fetched; no keys or project data leave the device. */
export class CatalogSynchronizer {
  private snapshot: Snapshot | null = null;
  private readonly request: typeof fetch;
  private readonly now: () => number;
  private pending: Promise<CatalogSyncStatus> | null = null;
  private controller: AbortController | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private unsubscribe: (() => void) | null = null;
  private current: CatalogSyncStatus = { source: CATALOG_SOURCE, state: 'bundled', fetchedAt: null, verifiedAt: null, error: null, changes: NO_CHANGES };

  constructor(private readonly options: CatalogSyncOptions) {
    this.request = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
    // Load synchronously before providers or the renderer see metadata; network never blocks startup.
    for (const file of [options.file, `${options.file}.previous`]) {
      if (!fs.existsSync(file)) continue;
      try {
        if (fs.statSync(file).size > MAX_BYTES) throw new Error('Catalog snapshot exceeds the size limit.');
        const snapshot = SnapshotSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
        if (!snapshot.catalog.providers.length) throw new Error('Empty cached catalog.');
        options.catalog.replace(snapshot.catalog);
        this.snapshot = snapshot;
        this.current = { ...this.current, state: 'cached', fetchedAt: snapshot.fetchedAt, verifiedAt: snapshot.verifiedAt };
        break;
      } catch (error) { options.log?.(`Ignored invalid catalog snapshot: ${redact(error instanceof Error ? error.message : String(error))}`); }
    }
  }

  status(): CatalogSyncStatus { return structuredClone(this.current); }

  /** Settings listener belongs to this service and is released with the fetch and timer. */
  listen(unsubscribe: () => void): void { this.unsubscribe?.(); this.unsubscribe = unsubscribe; }

  configure(enabled: boolean, intervalHours: number): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.stopped || !enabled) { this.controller?.abort(); return; }
    const interval = Math.max(1, Math.min(168, intervalHours)) * 60 * 60_000;
    if (this.snapshot === null || this.now() - this.snapshot.verifiedAt >= interval) void this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, interval);
    this.timer.unref();
  }

  refresh(): Promise<CatalogSyncStatus> {
    if (this.stopped) return Promise.resolve(this.status());
    if (this.pending) return this.pending;
    this.pending = this.update().finally(() => { this.pending = null; this.controller = null; });
    return this.pending;
  }

  dispose(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.controller?.abort();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private publish(status: CatalogSyncStatus): CatalogSyncStatus {
    this.current = status;
    if (!this.stopped) this.options.changed?.(this.status());
    return this.status();
  }

  private async update(): Promise<CatalogSyncStatus> {
    const before = this.status();
    this.controller = new AbortController();
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(30_000)]);
    this.publish({ ...before, state: 'refreshing', error: null });
    try {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (this.snapshot?.etag) headers['if-none-match'] = this.snapshot.etag;
      if (this.snapshot?.lastModified) headers['if-modified-since'] = this.snapshot.lastModified;
      const response = await this.request(CATALOG_SOURCE, { headers, signal, redirect: 'error', credentials: 'omit' });
      signal.throwIfAborted();
      if (response.status === 304) {
        if (!this.snapshot) throw new Error('Received 304 without a validated snapshot.');
        const next = { ...this.snapshot, verifiedAt: this.now() };
        this.persist(next);
        this.snapshot = next;
        return this.publish({ ...before, state: 'current', verifiedAt: next.verifiedAt, error: null, changes: NO_CHANGES });
      }
      if (!response.ok) throw new Error(`Model catalog update failed (HTTP ${String(response.status)}).`);
      const bytes = await this.read(response, signal);
      const incoming = decodeModelsDev(JSON.parse(bytes), new Date(this.now()).toISOString());
      const { catalog, changes } = reconcileCatalog(this.options.catalog.snapshot(), incoming);
      const next = SnapshotSchema.parse({ version: 1, source: CATALOG_SOURCE, fetchedAt: this.now(), verifiedAt: this.now(),
        etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified'), catalog });
      signal.throwIfAborted();
      this.persist(next);
      this.options.catalog.replace(next.catalog);
      this.snapshot = next;
      return this.publish({ source: CATALOG_SOURCE, state: 'current', fetchedAt: next.fetchedAt, verifiedAt: next.verifiedAt, error: null, changes });
    } catch (error) {
      if (signal.aborted && this.stopped) return this.status();
      const message = signal.aborted ? 'Model catalog refresh was cancelled or timed out.' : redact(error instanceof Error ? error.message : String(error));
      // Validation messages can be large; retain the verified metadata and show a bounded diagnostic.
      return this.publish({ ...before, state: 'error', error: message.slice(0, 1000) });
    }
  }

  private async read(response: Response, signal: AbortSignal): Promise<string> {
    if (Number(response.headers.get('content-length')) > MAX_BYTES) { await response.body?.cancel(); throw new Error('Model catalog exceeds the size limit.'); }
    if (!response.body) throw new Error('Model catalog response has no body.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    const cancel = (): void => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      while (true) {
        signal.throwIfAborted();
        const result = await reader.read();
        if (result.done) break;
        if (!(result.value instanceof Uint8Array)) throw new Error('Invalid model catalog response chunk.');
        size += result.value.byteLength;
        if (size > MAX_BYTES) throw new Error('Model catalog exceeds the size limit.');
        chunks.push(result.value);
      }
      return Buffer.concat(chunks).toString('utf8');
    } finally {
      signal.removeEventListener('abort', cancel);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  private persist(snapshot: Snapshot): void {
    const dir = path.dirname(this.options.file);
    fs.mkdirSync(dir, { recursive: true });
    const temp = path.join(dir, `.catalog-${randomUUID()}.tmp`);
    try {
      const serialized = JSON.stringify(snapshot);
      if (Buffer.byteLength(serialized) > MAX_BYTES) throw new Error('Catalog snapshot exceeds the size limit.');
      // A verified previous snapshot is retained even if the current file was corrupt at startup.
      if (this.snapshot) this.atomicWrite(`${this.options.file}.previous`, JSON.stringify(this.snapshot));
      fs.writeFileSync(temp, serialized, { flag: 'wx', mode: 0o600, flush: true });
      fs.renameSync(temp, this.options.file);
    } finally { fs.rmSync(temp, { force: true }); }
  }

  private atomicWrite(file: string, text: string): void {
    const temp = `${file}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temp, text, { flag: 'wx', mode: 0o600, flush: true }); fs.renameSync(temp, file); }
    finally { fs.rmSync(temp, { force: true }); }
  }
}
