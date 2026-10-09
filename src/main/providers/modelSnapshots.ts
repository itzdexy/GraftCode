import { z } from 'zod';
import { ModelInfoSchema, type ModelInfo } from '@shared/schemas/models';
import type { Db } from '../db/database';

export interface ModelSnapshot { at: number; models: ModelInfo[] }
export interface ModelSnapshotStore {
  get(providerId: string): ModelSnapshot | null;
  save(providerId: string, snapshot: ModelSnapshot): void;
  delete(providerId: string): void;
}
const SnapshotSchema = z.object({ at: z.number().int().nonnegative(), models: z.array(ModelInfoSchema).max(50_000) });

/** Metadata only. Provider deletion cascades; credentials and conversations are never stored here. */
export class SqliteModelSnapshots implements ModelSnapshotStore {
  constructor(private readonly db: Db, private readonly log: (message: string) => void = () => undefined) {}

  get(providerId: string): ModelSnapshot | null {
    const row = this.db.prepare('SELECT data FROM provider_model_snapshots WHERE provider_id = ?').get(providerId) as { data: string } | undefined;
    if (!row) return null;
    try { return SnapshotSchema.parse(JSON.parse(row.data)); }
    catch { this.log('Ignored invalid provider model snapshot.'); return null; }
  }

  save(providerId: string, snapshot: ModelSnapshot): void {
    const data = JSON.stringify(SnapshotSchema.parse(snapshot));
    this.db.prepare(`INSERT INTO provider_model_snapshots (provider_id, data) VALUES (?, ?)
      ON CONFLICT(provider_id) DO UPDATE SET data = excluded.data`).run(providerId, data);
  }

  delete(providerId: string): void {
    this.db.prepare('DELETE FROM provider_model_snapshots WHERE provider_id = ?').run(providerId);
  }
}
