import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CatalogSynchronizer, CATALOG_SOURCE } from '../../src/main/providers/catalogSync';
import { CatalogDataSchema, decodeModelsDev, reconcileCatalog } from '../../src/main/providers/catalogData';
import { ProviderCatalog } from '../../src/main/providers/presets';
import { makeTempDir, removeDir } from '../support/tmp';
import { json, startFixtureServer, type FixtureServer } from '../support/httpFixture';

function remote(models: Record<string, unknown> = { alpha: { id: 'alpha', name: 'Alpha', tool_call: true, limit: { context: 128000, output: 8192 } } }) {
  return { acme: { name: 'Acme', api: 'https://acme.test/v1', env: ['ACME_API_KEY'], models } };
}
let dir: string;
const services: CatalogSynchronizer[] = [];
beforeEach(() => { dir = makeTempDir(); });
afterEach(() => { for (const sync of services.splice(0)) sync.dispose(); removeDir(dir); });

function setup(fetcher: typeof fetch, now = () => 1000) {
  const catalog = new ProviderCatalog(null);
  const changed = vi.fn();
  const file = path.join(dir, 'snapshot.json');
  const sync = new CatalogSynchronizer({ file, catalog, fetch: fetcher, now, changed });
  services.push(sync);
  return { sync, catalog, file, changed };
}

describe('catalog lifecycle', () => {
  it('fetches only public metadata, persists it atomically and starts offline from the snapshot', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(remote()), { headers: { etag: 'v1' } }));
    const h = setup(fetcher);
    expect((await h.sync.refresh()).state).toBe('current');
    expect(fetcher).toHaveBeenCalledWith(CATALOG_SOURCE, expect.objectContaining({ credentials: 'omit', redirect: 'error', headers: { accept: 'application/json' } }));
    expect(h.catalog.model('acme', 'alpha')).toMatchObject({ context: 128000, tools: true });
    const file = JSON.parse(fs.readFileSync(h.file, 'utf8')) as { version: number; source: string };
    expect(file).toMatchObject({ version: 1, source: CATALOG_SOURCE });
    const reopened = setup(vi.fn<typeof fetch>().mockRejectedValue(new Error('offline')));
    expect(reopened.sync.status()).toMatchObject({ state: 'cached', verifiedAt: 1000 });
    expect((await reopened.sync.refresh()).state).toBe('error');
    expect(reopened.catalog.model('acme', 'alpha')?.context).toBe(128000);
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('uses conditional requests and persists 304 verification without replacing metadata', async () => {
    let time = 1000;
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(remote()), { headers: { etag: 'v1', 'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT' } }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    const h = setup(fetcher, () => time);
    await h.sync.refresh();
    const revision = h.catalog.revision;
    time = 2000;
    expect(await h.sync.refresh()).toMatchObject({ state: 'current', fetchedAt: 1000, verifiedAt: 2000, changes: { added: 0 } });
    expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({ 'if-none-match': 'v1', 'if-modified-since': 'Mon, 01 Jan 2024 00:00:00 GMT' });
    expect(h.catalog.revision).toBe(revision);
    expect(setup(fetcher).sync.status().verifiedAt).toBe(2000);
  });

  it.each(['malformed', 'schema', 'empty', 'http', 'oversize'])('keeps the last verified snapshot after a %s failure', async (kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify(remote())));
    const h = setup(fetcher);
    await h.sync.refresh();
    const disk = fs.readFileSync(h.file, 'utf8');
    const revision = h.catalog.revision;
    const bad = kind === 'malformed' ? new Response('{') : kind === 'schema' ? new Response(JSON.stringify(remote({ alpha: { id: 'alpha', limit: { context: -1 } } })))
      : kind === 'empty' ? new Response('{}') : kind === 'http' ? new Response('outage', { status: 503 })
        : new Response('{}', { headers: { 'content-length': String(40 * 1024 * 1024) } });
    fetcher.mockResolvedValueOnce(bad);
    expect((await h.sync.refresh()).state).toBe('error');
    expect(h.catalog.revision).toBe(revision);
    expect(fs.readFileSync(h.file, 'utf8')).toBe(disk);
  });

  it('falls back to the previous validated snapshot when the newest cache is corrupt', async () => {
    const h = setup(vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(remote())))
      .mockResolvedValueOnce(new Response(JSON.stringify(remote({ beta: { id: 'beta' } })))));
    await h.sync.refresh(); await h.sync.refresh();
    fs.writeFileSync(h.file, 'corrupt');
    const reopened = setup(vi.fn());
    expect(reopened.sync.status().state).toBe('cached');
    expect(reopened.catalog.model('acme', 'alpha')).not.toBeNull();
    expect(reopened.catalog.model('acme', 'beta')).toBeNull();
  });

  it('deduplicates overlapping refreshes and cancels a fetch on disposal', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    }));
    const h = setup(fetcher);
    const first = h.sync.refresh();
    expect(h.sync.refresh()).toBe(first);
    h.sync.dispose();
    await first;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(h.file)).toBe(false);
  });

  it('does not infer retirement from omission, a temporary outage or deprecation', () => {
    const before = decodeModelsDev(remote(), 'today');
    const incoming = decodeModelsDev(remote({ beta: { id: 'beta', status: 'deprecated' } }), 'tomorrow');
    const reconciled = reconcileCatalog(before, incoming);
    expect(reconciled.changes).toEqual({ added: 1, changed: 0, omitted: 1, deprecated: 1 });
    const catalog = new ProviderCatalog(null);
    catalog.replace(reconciled.catalog);
    expect(catalog.model('acme', 'alpha')).toMatchObject({ missing: true, deprecated: false });
    expect(catalog.models('acme').map((m) => m.id)).toEqual(['beta']);
    const again = reconcileCatalog(reconciled.catalog, incoming);
    expect(again.changes.omitted).toBe(0);
  });

  it('rejects unsafe URLs and duplicate IDs and represents absent capability evidence as unknown', () => {
    expect(() => decodeModelsDev({ acme: { api: 'javascript:alert(1)', models: {} } }, 'today')).toThrow();
    expect(() => decodeModelsDev({ acme: { api: 'https://user:secret@acme.test', models: {} } }, 'today')).toThrow();
    const decoded = decodeModelsDev(remote({ alpha: { id: 'alpha' } }), 'today');
    const catalog = new ProviderCatalog(null); catalog.replace(decoded);
    expect(catalog.model('acme', 'alpha')?.capabilities).toEqual({ tools: null, vision: null, reasoning: null, audio: null, structured: null });
    expect(CatalogDataSchema.safeParse({ providers: [...decoded.providers, ...decoded.providers] }).success).toBe(false);
  });

  it('handles current upstream experimental settings, null effort values and budget sentinels without importing provider overrides', () => {
    const decoded = decodeModelsDev(remote({ alpha: { id: 'alpha', experimental: { modes: { fast: { provider: { headers: { 'x-key': 'not executable' } } } } },
      reasoning_options: [{ type: 'effort', values: [null, 'low', 'high'] }, { type: 'budget_tokens', min: -1, max: 32000 }] },
      beta: { id: 'beta', experimental: true } }), 'today');
    expect(decoded.providers[0]?.models).toEqual([{ id: 'alpha', n: 'alpha', e: ['low', 'high'], b: [0, 32000] }]);
    expect(JSON.stringify(decoded)).not.toContain('x-key');
  });

  it('supports manual refresh when automatic updates are disabled', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(remote())));
    const h = setup(fetcher);
    h.sync.configure(false, 24);
    expect(fetcher).not.toHaveBeenCalled();
    expect((await h.sync.refresh()).state).toBe('current');
  });

  it('updates through a real HTTP fixture and exposes errors without replacing validated metadata', async () => {
    let server: FixtureServer | null = null;
    try {
      server = await startFixtureServer();
      const endpoint = `${server.url}/catalog`;
      let fail = false;
      server.route('GET', '/catalog', (_req, res) => json(res, fail ? 503 : 200, fail ? { error: 'unavailable' } : remote()));
      const h = setup((_url, options) => fetch(endpoint, options));
      expect((await h.sync.refresh()).state).toBe('current');
      fail = true;
      expect((await h.sync.refresh()).error).toContain('503');
      expect(h.catalog.models('acme')).toHaveLength(1);
    } finally { await server?.close(); }
  });
});
