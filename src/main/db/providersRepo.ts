import { randomUUID } from 'node:crypto';
import { GraftError } from '@shared/errors';
import type { ProviderKind } from '@shared/schemas/common';
import type { CustomModel } from '@shared/schemas/models';
import { parseJson, type Db } from './database';

export interface ProviderRecord {
  id: string;
  kind: ProviderKind;
  /** Catalog preset id; null for a custom OpenAI-compatible endpoint. */
  preset: string | null;
  label: string;
  baseUrl: string | null;
  enabled: boolean;
  isDefault: boolean;
  customModels: CustomModel[];
  createdAt: number;
}

interface Row {
  id: string;
  kind: ProviderKind;
  preset: string | null;
  label: string;
  base_url: string | null;
  enabled: number;
  is_default: number;
  custom_models: string;
  created_at: number;
}

function toRecord(row: Row): ProviderRecord {
  return {
    id: row.id,
    kind: row.kind,
    preset: row.preset,
    label: row.label,
    baseUrl: row.base_url,
    enabled: row.enabled === 1,
    isDefault: row.is_default === 1,
    customModels: parseJson<CustomModel[]>(row.custom_models, 'custom models'),
    createdAt: row.created_at
  };
}

export class ProvidersRepo {
  constructor(private readonly db: Db) {}

  list(): ProviderRecord[] {
    return (this.db.prepare('SELECT * FROM providers ORDER BY created_at ASC').all() as Row[]).map(toRecord);
  }

  get(id: string): ProviderRecord | null {
    const row = this.db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  require(id: string): ProviderRecord {
    const record = this.get(id);
    if (!record) throw new GraftError('provider_not_found', `Provider ${id} is not configured.`);
    return record;
  }

  create(input: { kind: ProviderKind; preset: string | null; label: string; baseUrl: string | null }): ProviderRecord {
    const id = randomUUID();
    const isFirst = (this.db.prepare('SELECT COUNT(*) AS n FROM providers').get() as { n: number }).n === 0;
    this.db
      .prepare(
        'INSERT INTO providers (id, kind, preset, label, base_url, enabled, is_default, custom_models, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)'
      )
      .run(id, input.kind, input.preset, input.label, input.baseUrl, isFirst ? 1 : 0, '[]', Date.now());
    return this.require(id);
  }

  update(
    id: string,
    patch: { label?: string; baseUrl?: string | null; enabled?: boolean; customModels?: CustomModel[] }
  ): ProviderRecord {
    this.require(id);
    if (patch.label !== undefined) this.db.prepare('UPDATE providers SET label = ? WHERE id = ?').run(patch.label, id);
    if (patch.baseUrl !== undefined) this.db.prepare('UPDATE providers SET base_url = ? WHERE id = ?').run(patch.baseUrl, id);
    if (patch.enabled !== undefined)
      this.db.prepare('UPDATE providers SET enabled = ? WHERE id = ?').run(patch.enabled ? 1 : 0, id);
    if (patch.customModels !== undefined)
      this.db.prepare('UPDATE providers SET custom_models = ? WHERE id = ?').run(JSON.stringify(patch.customModels), id);
    return this.require(id);
  }

  setDefault(id: string): void {
    this.require(id);
    const tx = this.db.transaction(() => {
      this.db.prepare('UPDATE providers SET is_default = 0').run();
      this.db.prepare('UPDATE providers SET is_default = 1 WHERE id = ?').run(id);
    });
    tx();
  }

  delete(id: string): void {
    const record = this.require(id);
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM providers WHERE id = ?').run(id);
      if (record.isDefault) {
        const next = this.db.prepare('SELECT id FROM providers ORDER BY created_at ASC LIMIT 1').get() as
          | { id: string }
          | undefined;
        if (next) this.db.prepare('UPDATE providers SET is_default = 1 WHERE id = ?').run(next.id);
      }
    });
    tx();
  }
}
