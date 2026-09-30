import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { GraftError } from '@shared/errors';
import { MIGRATIONS, type Migration } from './migrations';

export type Db = Database.Database;

/** Opens (creating if needed) the app database and brings it to the latest schema. */
export function openDatabase(file: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  let db: Db;
  try {
    db = new Database(file);
  } catch (error) {
    throw new GraftError('db_open_failed', `Could not open the database at ${file}: ${(error as Error).message}`, {
      cause: error
    });
  }
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  migrate(db);
  return db;
}

/** Applies pending migrations in order, each in its own transaction. Returns applied versions. */
export function migrate(db: Db, migrations: Migration[] = MIGRATIONS): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  ) STRICT`);
  const current = (db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as { v: number }).v;
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  const known = sorted.at(-1)?.version ?? 0;
  if (current > known) {
    throw new GraftError(
      'db_newer_schema',
      `The database schema (v${current}) is newer than this version of Graft supports (v${known}).`
    );
  }
  const applied: number[] = [];
  for (const migration of sorted) {
    if (migration.version <= current) continue;
    const run = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        Date.now()
      );
    });
    try {
      run();
    } catch (error) {
      throw new GraftError(
        'db_migration_failed',
        `Migration ${migration.version} (${migration.name}) failed: ${(error as Error).message}`,
        { cause: error }
      );
    }
    applied.push(migration.version);
  }
  return applied;
}

export function schemaVersion(db: Db): number {
  return (db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as { v: number }).v;
}

/** JSON column helpers with context in errors. */
export function parseJson<T>(raw: string, what: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new GraftError('db_corrupt_json', `Stored ${what} is not valid JSON.`, { cause: error });
  }
}
