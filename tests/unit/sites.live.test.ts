import { execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { siteScaffold, writeScaffold } from '../../src/main/sites/scaffold';
import { SiteServer } from '../../src/main/sites/siteServer';
import { makeTempDir, removeDir } from '../support/tmp';

// The starter of a TypeScript site, installed and built for real. It needs npm and the network and
// takes about a minute, so it runs only when asked: GRAFT_LIVE_SITE=1 npx vitest run tests/unit/sites.live.test.ts
// Run it whenever SITE_PACKAGES or the starter's files change.
const live = process.env.GRAFT_LIVE_SITE === '1';

function get(port: number, host: string, urlPath: string): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, headers: { host }, agent: false }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString('utf8')));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

describe.skipIf(!live)('the starter of a TypeScript site, installed and built (GRAFT_LIVE_SITE=1)', () => {
  it('installs, passes its type check, builds a page with relative addresses that Graft serves, and fails its build on a type error', async () => {
    // A folder with a space and brackets in its name, as a home folder on Windows may have.
    const folder = makeTempDir('graft site (tmp) ');
    cleanup.push(() => removeDir(folder));
    writeScaffold(folder, siteScaffold("Tom's \"Peach\" Palace", 'peach-palace'));
    // As a shell of the user's would run it: without the settings this test's own npm passes down to what it starts.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_/i.test(key)));
    const npm = (command: string): string => execSync(`npm ${command}`, { cwd: folder, env, stdio: 'pipe', timeout: 280_000 }).toString();

    npm('install --no-audit --no-fund');
    npm('run typecheck');
    npm('run build');

    const html = fs.readFileSync(path.join(folder, 'dist', 'index.html'), 'utf8');
    expect(html).toContain('<div id="root"></div>');
    expect(html).toMatch(/src="\.\/assets\/[^"]+\.js"/);
    expect(html).toMatch(/href="\.\/assets\/[^"]+\.css"/);
    const assets = fs.readdirSync(path.join(folder, 'dist', 'assets'));
    const script = fs.readFileSync(path.join(folder, 'dist', 'assets', assets.find((f) => f.endsWith('.js'))!), 'utf8');
    expect(script).toContain('Peach');
    expect(script).toContain('This site is being built.');

    // Graft's own server shows the built page with what it links, each as what it is.
    const root = path.dirname(folder);
    const slug = path.basename(folder).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    fs.renameSync(folder, path.join(root, slug));
    cleanup.push(() => removeDir(path.join(root, slug)));
    const server = new SiteServer(root, () => undefined, () => null, () => true);
    const port = await server.start();
    try {
      const host = `${slug}.localhost:${port}`;
      const page = await get(port, host, '/');
      expect(page.status).toBe(200);
      expect(page.body).toContain('/__graft/version');
      const scriptPath = /src="\.(\/assets\/[^"]+\.js)"/.exec(page.body)![1]!;
      const stylePath = /href="\.(\/assets\/[^"]+\.css)"/.exec(page.body)![1]!;
      expect((await get(port, host, scriptPath)).type).toContain('text/javascript');
      expect((await get(port, host, stylePath)).type).toContain('text/css');
      expect((await get(port, host, '/package.json')).status).toBe(404);
    } finally {
      await server.close();
      fs.renameSync(path.join(root, slug), folder);
    }

    // The build is the check: a type error stops it, and the page that was built stays as it was.
    fs.writeFileSync(path.join(folder, 'src', 'broken.ts'), 'export const count: number = "three";\n');
    let failure = '';
    try {
      npm('run build');
    } catch (error) {
      const failed = error as { stdout?: Buffer; stderr?: Buffer };
      failure = `${failed.stdout?.toString() ?? ''}${failed.stderr?.toString() ?? ''}`;
    }
    expect(failure).toMatch(/broken\.ts.*TS2322/s);
    expect(fs.readFileSync(path.join(folder, 'dist', 'index.html'), 'utf8')).toBe(html);
  }, 300_000);
});
