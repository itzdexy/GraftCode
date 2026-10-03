import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sitesDir } from '../../src/main/app/paths';
import { resolveSitePath, SiteServer, siteFromHost, withReload } from '../../src/main/sites/siteServer';
import { siteName, siteSlug, SitesStore, starterPage } from '../../src/main/sites/sites';
import { makeTempDir, removeDir, writeFile } from '../support/tmp';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function get(port: number, host: string, urlPath = '/'): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    // Straight to the loopback address with the Host header a browser would send for *.localhost.
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, headers: { host }, agent: false }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString('utf8')));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('site names', () => {
  it('turns names into folder and host names', () => {
    expect(siteSlug('Peach Palace')).toBe('peach-palace');
    expect(siteSlug('  Café Crème! ')).toBe('cafe-creme');
    expect(siteSlug('!!!')).toBe('site');
    expect(siteSlug('a'.repeat(60))).toHaveLength(40);
  });

  it('takes the name the user gave, or the first words', () => {
    expect(siteName('A warm site for my bakery called Peach Palace, with online orders')).toBe('Peach Palace');
    expect(siteName('Portfolio named "Nova Studio" for a designer')).toBe('Nova Studio');
    expect(siteName('A website for my bakery called Peach Palace: seasonal bakes and a menu')).toBe('Peach Palace');
    expect(siteName('landing page for a running app')).toBe('Landing page for a');
    expect(siteName('   ')).toBe('New site');
  });
});

describe('the sites store', () => {
  it('creates sites, finds them by folder and keeps their details', () => {
    const root = makeTempDir();
    cleanup.push(() => removeDir(root));
    let now = 1000;
    const store = new SitesStore(root, () => now);
    const site = store.create('Peach Palace', 'A bakery site');
    expect(site).toMatchObject({ slug: 'peach-palace', name: 'Peach Palace', description: 'A bakery site', sessionId: null });
    // Nothing is written into the site itself: the agent writes index.html fresh.
    expect(fs.existsSync(path.join(site.folder, 'index.html'))).toBe(false);
    // A second site with the same name gets its own folder.
    expect(store.create('Peach Palace', '').slug).toBe('peach-palace-2');
    now = 2000;
    store.update('peach-palace', { sessionId: 'session-9', touched: true });
    expect(store.list().map((s) => [s.slug, s.sessionId])).toEqual([
      ['peach-palace', 'session-9'],
      ['peach-palace-2', null]
    ]);
    expect(store.forFolder(path.join(site.folder, 'assets'))?.slug).toBe('peach-palace');
    expect(store.forFolder(root)).toBeNull();
    expect(store.forFolder(makeTempDir())).toBeNull();
    expect(store.thumbnail('peach-palace')).toBeNull();
    store.saveThumbnail('peach-palace', Buffer.from('png'));
    expect(store.thumbnail('peach-palace')).toBe(`data:image/png;base64,${Buffer.from('png').toString('base64')}`);
  });

  it('lives in the home folder, not Documents, unless an earlier version already made a Documents folder', () => {
    vi.stubEnv('GRAFT_HOME', undefined);
    vi.stubEnv('GRAFT_SITES_DIR', undefined);
    cleanup.push(() => {
      vi.unstubAllEnvs();
    });
    const home = makeTempDir();
    cleanup.push(() => removeDir(home));
    const graftHome = path.join(home, '.graft');
    const documents = path.join(home, 'Documents');
    expect(sitesDir(graftHome, documents, home)).toBe(path.join(home, 'Graft Sites'));
    // Sites made by 0.6.3 stay where they are.
    fs.mkdirSync(path.join(documents, 'Graft Sites'), { recursive: true });
    expect(sitesDir(graftHome, documents, home)).toBe(path.join(documents, 'Graft Sites'));
    vi.stubEnv('GRAFT_HOME', graftHome);
    expect(sitesDir(graftHome, documents, home)).toBe(path.join(graftHome, 'sites'));
    vi.stubEnv('GRAFT_SITES_DIR', path.join(home, 'elsewhere'));
    expect(sitesDir(graftHome, documents, home)).toBe(path.join(home, 'elsewhere'));
  });
});

describe('serving sites', () => {
  it('only answers for its own *.localhost names', () => {
    expect(siteFromHost('peach-palace.localhost:4870', 4870)).toBe('peach-palace');
    expect(siteFromHost('Peach-Palace.LOCALHOST:4870', 4870)).toBe('peach-palace');
    expect(siteFromHost('peach-palace.localhost:4871', 4870)).toBeNull();
    expect(siteFromHost('evil.example.com:4870', 4870)).toBeNull();
    expect(siteFromHost('127.0.0.1:4870', 4870)).toBeNull();
    expect(siteFromHost(undefined, 4870)).toBeNull();
  });

  it('serves files inside the site and nothing hidden or outside it', () => {
    const folder = makeTempDir();
    cleanup.push(() => removeDir(folder));
    writeFile(folder, 'index.html', '<h1>home</h1>');
    writeFile(folder, 'about.html', 'about');
    writeFile(folder, 'blog/index.html', 'blog');
    writeFile(folder, '.graft-site/site.json', '{}');
    writeFile(folder, '.env', 'SECRET=1');
    expect(resolveSitePath(folder, '/')).toBe(path.join(folder, 'index.html'));
    expect(resolveSitePath(folder, '/about')).toBe(path.join(folder, 'about.html'));
    expect(resolveSitePath(folder, '/blog/')).toBe(path.join(folder, 'blog', 'index.html'));
    expect(resolveSitePath(folder, '/.graft-site/site.json')).toBeNull();
    expect(resolveSitePath(folder, '/.env')).toBeNull();
    expect(resolveSitePath(folder, '/../outside.txt')).toBeNull();
    expect(resolveSitePath(folder, '/%2e%2e/outside.txt')).toBeNull();
    expect(resolveSitePath(folder, '/a%5c..%5c..%5coutside')).toBeNull();
    expect(resolveSitePath(folder, '/missing.css')).toBeNull();
  });

  it('adds live reload to pages', () => {
    expect(withReload('<html><body><p>x</p></body></html>')).toMatch(/<p>x<\/p><script>.*fetch\('\/__graft\/version'.*<\/script><\/body><\/html>$/);
    expect(withReload('<p>no body tag</p>')).toMatch(/^<p>no body tag<\/p><script>/);
  });

  it('serves a site over HTTP, refuses other hosts, and tells open pages to reload after a change', async () => {
    const root = makeTempDir();
    const store = new SitesStore(root);
    const site = store.create('Peach Palace', '');
    writeFile(site.folder, 'styles.css', 'body{}');
    const server = new SiteServer(root, () => undefined, (slug) => {
      const found = store.get(slug);
      return found ? starterPage(found.name) : null;
    });
    const port = await server.start();
    cleanup.push(async () => {
      await server.close();
      removeDir(root);
    });
    expect(server.url('peach-palace')).toBe(`http://peach-palace.localhost:${port}/`);

    // Before the agent writes index.html, the site shows the starter page.
    const starter = await get(port, `peach-palace.localhost:${port}`);
    expect(starter.status).toBe(200);
    expect(starter.body).toContain('Graft is building this site');
    writeFile(site.folder, 'index.html', '<!doctype html><title>Peach Palace</title><body><h1>Peach Palace</h1></body>');
    const page = await get(port, `peach-palace.localhost:${port}`);
    expect(page.status).toBe(200);
    expect(page.type).toContain('text/html');
    expect(page.body).toContain('Peach Palace');
    expect(page.body).toContain('/__graft/version');
    expect((await get(port, `peach-palace.localhost:${port}`, '/styles.css')).type).toContain('text/css');
    expect((await get(port, `peach-palace.localhost:${port}`, '/.graft-site/site.json')).status).toBe(404);
    expect((await get(port, `evil.example.com:${port}`)).status).toBe(403);
    expect((await get(port, `other-site.localhost:${port}`)).status).toBe(404);

    // An open page sees the site's version move after a change to its files.
    const version = async (): Promise<string> => (await get(port, `peach-palace.localhost:${port}`, '/__graft/version')).body;
    const before = await version();
    await new Promise((resolve) => setTimeout(resolve, 150));
    writeFile(site.folder, 'index.html', '<h1>changed</h1>');
    let after = before;
    for (let i = 0; i < 40 && after === before; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      after = await version();
    }
    expect(after).not.toBe(before);
    // Graft's own files don't count as a change.
    const settled = await version();
    store.saveThumbnail('peach-palace', Buffer.from('png'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await version()).toBe(settled);
  });
});
