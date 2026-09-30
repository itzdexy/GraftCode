import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { GraftError } from '@shared/errors';
import { EffortLevelSchema, ModelRefSchema, PermissionModeSchema } from '@shared/schemas/common';
import { parseJson, type Db } from './database';

export const ProjectSettingsSchema = z.object({
  model: ModelRefSchema.optional(),
  effort: EffortLevelSchema.optional(),
  permissionMode: PermissionModeSchema.optional(),
  useWorktree: z.boolean().optional()
});
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

export interface ProjectRecord {
  id: string;
  path: string;
  name: string;
  trusted: boolean;
  settings: ProjectSettings;
  createdAt: number;
  lastUsedAt: number;
}

interface Row {
  id: string;
  path: string;
  name: string;
  trusted: number;
  settings: string;
  created_at: number;
  last_used_at: number;
}

/** Canonical key so C:\Repo and c:/repo/ are the same project on Windows. */
export function pathKey(p: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = path.resolve(p).replace(/[\\/]+$/, '');
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function toRecord(row: Row): ProjectRecord {
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    trusted: row.trusted === 1,
    settings: ProjectSettingsSchema.parse(parseJson<unknown>(row.settings, 'project settings')),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at
  };
}

export class ProjectsRepo {
  constructor(private readonly db: Db) {}

  list(): ProjectRecord[] {
    return (this.db.prepare('SELECT * FROM projects ORDER BY last_used_at DESC').all() as Row[]).map(toRecord);
  }

  get(id: string): ProjectRecord | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  require(id: string): ProjectRecord {
    const record = this.get(id);
    if (!record) throw new GraftError('project_not_found', `Project ${id} does not exist.`);
    return record;
  }

  findByPath(p: string): ProjectRecord | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE path_key = ?').get(pathKey(p)) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  /** Returns the project for a folder, creating it on first use, and marks it recently used. */
  upsert(folder: string): ProjectRecord {
    const existing = this.findByPath(folder);
    const now = Date.now();
    if (existing) {
      this.db.prepare('UPDATE projects SET last_used_at = ? WHERE id = ?').run(now, existing.id);
      return { ...existing, lastUsedAt: now };
    }
    const id = randomUUID();
    const resolved = path.resolve(folder);
    const name = path.basename(resolved) || resolved;
    this.db
      .prepare(
        'INSERT INTO projects (id, path, path_key, name, trusted, settings, created_at, last_used_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)'
      )
      .run(id, resolved, pathKey(resolved), name, '{}', now, now);
    return this.require(id);
  }

  update(id: string, patch: { name?: string; trusted?: boolean; settings?: ProjectSettings }): ProjectRecord {
    this.require(id);
    if (patch.name !== undefined) this.db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(patch.name, id);
    if (patch.trusted !== undefined)
      this.db.prepare('UPDATE projects SET trusted = ? WHERE id = ?').run(patch.trusted ? 1 : 0, id);
    if (patch.settings !== undefined)
      this.db
        .prepare('UPDATE projects SET settings = ? WHERE id = ?')
        .run(JSON.stringify(ProjectSettingsSchema.parse(patch.settings)), id);
    return this.require(id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }
}
