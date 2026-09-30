import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, schemaVersion, type Db } from '../../src/main/db/database';
import { MIGRATIONS } from '../../src/main/db/migrations';
import { SessionsRepo } from '../../src/main/db/sessionsRepo';
import { ProjectsRepo, pathKey } from '../../src/main/db/projectsRepo';
import { ProvidersRepo } from '../../src/main/db/providersRepo';
import { AppSettingsService } from '../../src/main/settings/appSettings';
import { KeyStore, type Encryptor } from '../../src/main/secrets/keyStore';
import { makeTempDir, removeDir } from '../support/tmp';

let dir: string;
let db: Db;

beforeEach(() => {
  dir = makeTempDir();
  db = openDatabase(path.join(dir, 'graft.db'));
});
afterEach(() => {
  db.close();
  removeDir(dir);
});

describe('migrations', () => {
  it('creates the schema once and is idempotent on reopen', () => {
    expect(schemaVersion(db)).toBe(MIGRATIONS.at(-1)?.version);
    expect(migrate(db)).toEqual([]);
    db.close();
    db = openDatabase(path.join(dir, 'graft.db'));
    expect(schemaVersion(db)).toBe(MIGRATIONS.at(-1)?.version);
  });

  it('refuses a database written by a newer version', () => {
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (999, ?, ?)').run('future', Date.now());
    expect(() => migrate(db)).toThrow(/newer than this version/);
  });

  it('rolls back a failing migration and reports it with context', () => {
    const broken = [...MIGRATIONS, { version: 2, name: 'broken', sql: 'CREATE TABLE ok_table (x INTEGER); NOT VALID SQL;' }];
    expect(() => migrate(db, broken)).toThrow(/Migration 2 \(broken\) failed/);
    expect(schemaVersion(db)).toBe(1);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'ok_table'").get()).toBeUndefined();
  });
});

describe('sessions and messages', () => {
  it('appends messages with increasing sequence numbers and rewinds from a point', () => {
    const repo = new SessionsRepo(db);
    const s = repo.create({
      kind: 'code',
      title: 'Fix the parser',
      projectId: null,
      cwd: dir,
      worktreePath: null,
      branch: null,
      baseBranch: null,
      model: { providerId: 'p1', modelId: 'm1' },
      effort: 'medium',
      permissionMode: 'ask'
    });
    const m1 = repo.appendMessage(s.id, 'user', [{ type: 'text', text: 'first' }], {});
    const m2 = repo.appendMessage(s.id, 'assistant', [{ type: 'text', text: 'second' }], {});
    const m3 = repo.appendMessage(s.id, 'user', [{ type: 'text', text: 'third' }], {});
    expect([m1.seq, m2.seq, m3.seq]).toEqual([1, 2, 3]);
    const removed = repo.deleteMessagesFrom(s.id, 2);
    expect(removed.map((m) => m.id)).toEqual([m2.id, m3.id]);
    expect(repo.listMessages(s.id).map((m) => m.id)).toEqual([m1.id]);
    expect(repo.search('third')).toEqual([]);
  });

  it('searches titles and message bodies by substring, treating quotes literally', () => {
    const repo = new SessionsRepo(db);
    const base = {
      kind: 'chat' as const,
      projectId: null,
      cwd: null,
      worktreePath: null,
      branch: null,
      baseBranch: null,
      model: null,
      effort: null,
      permissionMode: 'ask' as const
    };
    const a = repo.create({ ...base, title: 'Tokenizer refactor' });
    const b = repo.create({ ...base, title: 'Other' });
    repo.appendMessage(b.id, 'user', [{ type: 'text', text: 'the flaky "websocket" reconnect test' }], {});
    expect(repo.search('kenize').map((h) => h.sessionId)).toEqual([a.id]);
    expect(repo.search('ebsock').map((h) => h.sessionId)).toEqual([b.id]);
    expect(repo.search('"websocket"').map((h) => h.sessionId)).toEqual([b.id]);
    expect(repo.search('ab')).toEqual([]);
    repo.updateSession(a.id, { title: 'Lexer cleanup' });
    expect(repo.search('kenize')).toEqual([]);
    expect(repo.search('Lexer').map((h) => h.sessionId)).toEqual([a.id]);
  });

  it('does not reorder the list on status changes', () => {
    const repo = new SessionsRepo(db);
    const base = {
      kind: 'code' as const,
      projectId: null,
      cwd: null,
      worktreePath: null,
      branch: null,
      baseBranch: null,
      model: null,
      effort: null,
      permissionMode: 'ask' as const
    };
    const first = repo.create({ ...base, title: 'one' });
    const before = repo.getSummary(first.id).updatedAt;
    repo.updateSession(first.id, { status: 'running', unread: true });
    expect(repo.getSummary(first.id).updatedAt).toBe(before);
  });
});

describe('projects and providers', () => {
  it('dedupes projects by normalized path', () => {
    const repo = new ProjectsRepo(db);
    const a = repo.upsert(dir);
    const b = repo.upsert(`${dir}${path.sep}`);
    expect(b.id).toBe(a.id);
    expect(pathKey('C:\\Repo\\', 'win32')).toBe(pathKey('c:\\repo', 'win32'));
  });

  it('makes the first provider the default and moves the default on delete', () => {
    const repo = new ProvidersRepo(db);
    const a = repo.create({ kind: 'anthropic', label: 'A', baseUrl: null });
    const b = repo.create({ kind: 'ollama', label: 'B', baseUrl: 'http://localhost:11434' });
    expect(repo.get(a.id)?.isDefault).toBe(true);
    expect(repo.get(b.id)?.isDefault).toBe(false);
    repo.delete(a.id);
    expect(repo.get(b.id)?.isDefault).toBe(true);
  });
});

describe('app settings', () => {
  it('returns defaults, persists partial updates, and rejects invalid values', () => {
    const settings = new AppSettingsService(db);
    expect(settings.get().appearance.theme).toBe('system');
    settings.update({ appearance: { theme: 'dark' }, profile: { name: 'Robin' } });
    const reopened = new AppSettingsService(db);
    expect(reopened.get().appearance).toMatchObject({ theme: 'dark', uiFontSize: 13 });
    expect(reopened.get().profile.name).toBe('Robin');
    expect(() => settings.update({ appearance: { uiFontSize: 99 } })).toThrow(/uiFontSize/);
    expect(settings.get().appearance.uiFontSize).toBe(13);
  });

  it('falls back to defaults for a corrupt section only', () => {
    new AppSettingsService(db).update({ profile: { name: 'Kai' } });
    db.prepare("INSERT OR REPLACE INTO app_settings (section, value) VALUES ('appearance', '{not json')").run();
    const settings = new AppSettingsService(db);
    expect(settings.get().appearance.theme).toBe('system');
    expect(settings.get().profile.name).toBe('Kai');
  });
});

describe('key store', () => {
  const fakeEncryptor = (available: boolean): Encryptor => ({
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from(`enc:${Buffer.from(s).toString('base64')}`),
    decryptString: (b) => Buffer.from(b.toString().slice(4), 'base64').toString()
  });

  it('encrypts keys with the keyring and never stores plaintext', () => {
    const store = new KeyStore(db, fakeEncryptor(true), () => false);
    store.set('p1', 'sk-test-123456789012345');
    const raw = db.prepare('SELECT blob, encrypted FROM secrets WHERE id = ?').get('p1') as { blob: Buffer; encrypted: number };
    expect(raw.encrypted).toBe(1);
    expect(raw.blob.toString()).not.toContain('sk-test');
    expect(store.get('p1')).toBe('sk-test-123456789012345');
  });

  it('refuses plaintext storage without the opt-in, and allows it with the opt-in', () => {
    let allow = false;
    const store = new KeyStore(db, fakeEncryptor(false), () => allow);
    expect(() => store.set('p1', 'secret')).toThrow(/keyring isn't available/);
    expect(store.has('p1')).toBe(false);
    allow = true;
    store.set('p1', 'secret');
    expect(store.get('p1')).toBe('secret');
    allow = false;
    expect(() => store.get('p1')).toThrow(/keyring/);
    expect(store.purgePlaintext()).toBe(1);
    expect(store.has('p1')).toBe(false);
  });
});
