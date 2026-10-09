import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type Db } from '../../src/main/db/database';
import { ProvidersRepo } from '../../src/main/db/providersRepo';
import { KeyStore } from '../../src/main/secrets/keyStore';
import { ProviderRegistry, type ProviderFactory } from '../../src/main/providers/registry';
import { ProviderCatalog } from '../../src/main/providers/presets';
import { SqliteModelSnapshots } from '../../src/main/providers/modelSnapshots';
import { ProviderError } from '../../src/main/providers/errors';
import type { ModelInfo } from '../../src/shared/schemas/models';
import { fakeModel } from '../support/fakeProvider';
import { makeTempDir, removeDir } from '../support/tmp';

let dir: string;
let db: Db;
beforeEach(() => { dir = makeTempDir(); db = openDatabase(path.join(dir, 'graft.db')); });
afterEach(() => { db.close(); removeDir(dir); });

function setup() {
  const repo = new ProvidersRepo(db);
  const keys = new KeyStore(db, { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() }, () => true);
  const record = repo.create({ kind: 'openai-compatible', preset: 'acme', label: 'Acme', baseUrl: 'https://acme.test/v1' });
  keys.set(record.id, 'prefix-aaaaaa-suffix');
  const catalog = new ProviderCatalog(null);
  const list = vi.fn<() => Promise<ModelInfo[]>>().mockResolvedValue([fakeModel({ ref: { providerId: record.id, modelId: 'alpha' } })]);
  const factory: ProviderFactory = vi.fn<ProviderFactory>((connection) => ({ id: connection.id, kind: connection.kind, listModels: list, async *streamText() { await Promise.resolve(); yield { type: 'finish' as const, reason: 'stop' as const }; } }));
  const snapshots = new SqliteModelSnapshots(db);
  const registry = new ProviderRegistry(repo, keys, catalog, factory, snapshots);
  return { repo, keys, record, catalog, list, factory, snapshots, registry };
}

describe('provider metadata recovery', () => {
  it('persists model metadata and shows a temporary outage after restart without retiring a model', async () => {
    const h = setup();
    await h.registry.listModels(h.record.id);
    h.list.mockRejectedValue(new ProviderError('network', 'offline'));
    const reopened = new ProviderRegistry(h.repo, h.keys, h.catalog, h.factory, h.snapshots);
    const results = await reopened.allModels();
    expect(results[0]?.models[0]).toMatchObject({ availability: { state: 'temporarily-unavailable', source: 'cache', selectable: false } });
    expect(results[0]?.error?.code).toBe('network');
    expect(h.snapshots.get(h.record.id)?.models[0]?.availability?.state).toBe('available');
  });

  it('retains metadata on omission, preserves the selection, and allows recovery on a later refresh', async () => {
    const h = setup();
    const before = await h.registry.listModels(h.record.id);
    h.list.mockResolvedValueOnce([]);
    expect((await h.registry.listModels(h.record.id, { refresh: true }))[0]).toMatchObject({ availability: { state: 'unknown', selectable: false } });
    await expect(h.registry.resolveModel(before[0]!.ref)).rejects.toMatchObject({ code: 'model_unavailable' });
    expect((await h.registry.listModels(h.record.id, { refresh: true }))[0]?.availability?.state).toBe('available');
  });

  it('reports auth failures separately from outages', async () => {
    const h = setup(); await h.registry.listModels(h.record.id);
    h.list.mockRejectedValue(new ProviderError('auth', 'account denied'));
    expect((await h.registry.allModels({ refresh: true }))[0]?.models[0]?.availability?.state).toBe('not-accessible');
  });

  it('preserves explicit shutdown evidence through catalog deprecation, omission, restart and outages', async () => {
    const h = setup();
    h.catalog.replace({ providers: [{ id: 'acme', name: 'Acme', kind: 'openai-compatible', api: 'https://acme.test/v1', env: [], doc: null,
      key: 'required', models: [{ id: 'alpha', n: 'Alpha', s: 'deprecated' }] }] });
    h.list.mockResolvedValue([fakeModel({ ref: { providerId: h.record.id, modelId: 'alpha' },
      lifecycle: { shutdownDate: '2020-01-01', source: 'openai-models-api', sourceUrl: 'https://api.openai.com/v1/models' } })]);
    expect((await h.registry.listModels(h.record.id))[0]?.availability).toMatchObject({ state: 'confirmed-retired', selectable: false });
    h.list.mockResolvedValueOnce([]);
    expect((await h.registry.listModels(h.record.id, { refresh: true }))[0]?.availability?.state).toBe('confirmed-retired');
    h.list.mockRejectedValue(new ProviderError('network', 'offline'));
    const reopened = new ProviderRegistry(h.repo, h.keys, h.catalog, h.factory, h.snapshots);
    expect((await reopened.allModels())[0]?.models[0]?.availability).toMatchObject({ state: 'confirmed-retired', source: 'provider', selectable: false });
    await expect(h.registry.resolveModel({ providerId: h.record.id, modelId: 'alpha' })).rejects.toMatchObject({ code: 'model_unavailable' });
  });

  it('updates provider instances and cached metadata when the live catalog revision changes', async () => {
    const h = setup(); await h.registry.listModels(h.record.id);
    h.catalog.replace({ providers: [{ id: 'acme', name: 'Acme', kind: 'openai-compatible', api: 'https://acme.test/v1', env: [], doc: null,
      key: 'required', models: [{ id: 'alpha', n: 'Alpha', t: 1, s: 'deprecated', p: [2, 4] }] }] });
    expect((await h.registry.listModels(h.record.id))[0]).toMatchObject({ pricing: { input: 2, output: 4 }, availability: { state: 'deprecated' }, catalogCapabilities: { tools: true, audio: null } });
    expect(h.factory).toHaveBeenCalledTimes(2);
    expect(h.list).toHaveBeenCalledTimes(2);
  });

  it('rebuilds the adapter when keys with identical lengths and suffixes are rotated', () => {
    const h = setup();
    const first = h.registry.get(h.record.id);
    h.keys.set(h.record.id, 'prefix-bbbbbb-suffix');
    expect(h.registry.get(h.record.id)).not.toBe(first);
  });

  it('does not cache a response that finishes after provider configuration changed', async () => {
    const h = setup();
    let resolve!: (models: ModelInfo[]) => void;
    h.list.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = h.registry.listModels(h.record.id);
    h.registry.invalidate(h.record.id);
    resolve([fakeModel({ ref: { providerId: h.record.id, modelId: 'old' } })]);
    await expect(pending).rejects.toMatchObject({ code: 'provider_changed' });
    expect(h.snapshots.get(h.record.id)).toBeNull();
    expect((await h.registry.listModels(h.record.id))[0]?.ref.modelId).toBe('alpha');
  });

  it('does not persist a cancelled discovery even when an adapter ignores its signal', async () => {
    const h = setup(); const controller = new AbortController();
    controller.abort();
    await expect(h.registry.listModels(h.record.id, { signal: controller.signal })).rejects.toThrow();
    expect(h.snapshots.get(h.record.id)).toBeNull();
  });

  it('deletes cached account metadata when the provider is deleted', async () => {
    const h = setup(); await h.registry.listModels(h.record.id);
    h.repo.delete(h.record.id);
    expect(h.snapshots.get(h.record.id)).toBeNull();
  });
});
