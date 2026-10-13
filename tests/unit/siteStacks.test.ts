import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { suggestChecks } from '../../src/main/agent/checks';
import { buildCodeSystemPrompt, type CodePromptContext } from '../../src/main/agent/systemPrompt';
import { siteScaffold, writeScaffold } from '../../src/main/sites/scaffold';
import { SiteServer } from '../../src/main/sites/siteServer';
import { SitesStore, starterPage } from '../../src/main/sites/sites';
import { makeTempDir, removeDir, writeFile } from '../support/tmp';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function get(port: number, host: string, urlPath = '/'): Promise<{ status: number; type: string; body: string }> {
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

describe('the starter of a TypeScript site', () => {
  it('is a React and TypeScript project whose build type-checks first', () => {
    const files = siteScaffold('Peach Palace', 'peach-palace');
    expect(Object.keys(files).sort()).toEqual(
      ['.gitignore', 'README.md', 'index.html', 'package.json', 'src/App.module.css', 'src/App.tsx', 'src/main.tsx', 'src/styles/global.css', 'src/styles/tokens.css', 'src/vite-env.d.ts', 'tsconfig.json', 'vite.config.ts'].sort()
    );
    const pkg = JSON.parse(files['package.json']!) as { name: string; private: boolean; type: string; scripts: Record<string, string>; dependencies: Record<string, string>; devDependencies: Record<string, string> };
    expect(pkg).toMatchObject({ name: 'peach-palace', private: true, type: 'module' });
    expect(pkg.scripts).toMatchObject({ build: 'tsc --noEmit && vite build', typecheck: 'tsc --noEmit', dev: 'vite' });
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['react', 'react-dom']);
    expect(Object.keys(pkg.devDependencies).sort()).toEqual(['@types/react', '@types/react-dom', '@vitejs/plugin-react', 'typescript', 'vite']);
    // Exact versions: the same starter installs the same packages next month.
    for (const version of [...Object.values(pkg.dependencies), ...Object.values(pkg.devDependencies)]) expect(version).toMatch(/^\d+\.\d+\.\d+$/);

    const tsconfig = JSON.parse(files['tsconfig.json']!) as { compilerOptions: Record<string, unknown>; include: string[] };
    expect(tsconfig.compilerOptions).toMatchObject({ strict: true, noEmit: true, jsx: 'react-jsx', noUncheckedIndexedAccess: true, noUnusedLocals: true });
    expect(tsconfig.include).toContain('src');
    expect(files['index.html']).toContain('<div id="root"></div>');
    expect(files['index.html']).toContain('<script type="module" src="/src/main.tsx"></script>');
    // Every address in the built site is relative, so the dist folder works wherever it is put.
    expect(files['vite.config.ts']).toContain("base: './'");
    expect(files['src/main.tsx']).toContain("createRoot(");
    expect(files['.gitignore']).toMatch(/^node_modules$/m);
    expect(files['.gitignore']).toMatch(/^dist$/m);
  });

  it("carries the site's name as text, whatever is in it", () => {
    const name = `Tom's "Best" <script>alert(1)</script> & Co {x}`;
    const files = siteScaffold(name, 'toms-best');
    expect(files['index.html']).not.toContain('<script>alert(1)</script>');
    expect(files['index.html']).toContain('<title>Tom&#39;s &quot;Best&quot; &lt;script&gt;alert(1)&lt;/script&gt; &amp; Co {x}</title>');
    // In the component the name is a string, not markup.
    expect(files['src/App.tsx']).toContain(`const NAME = ${JSON.stringify(name)};`);
    expect((JSON.parse(files['package.json']!) as { name: string }).name).toBe('toms-best');
  });

  it('gives Graft a check to run: the type check', () => {
    const folder = makeTempDir();
    cleanup.push(() => removeDir(folder));
    writeScaffold(folder, siteScaffold('Peach Palace', 'peach-palace'));
    expect(suggestChecks(folder)).toEqual(['npm run typecheck']);
  });

  it('never writes over a file that is already there', () => {
    const folder = makeTempDir();
    cleanup.push(() => removeDir(folder));
    writeFile(folder, 'src/App.tsx', 'mine');
    writeScaffold(folder, siteScaffold('Peach Palace', 'peach-palace'));
    expect(fs.readFileSync(path.join(folder, 'src', 'App.tsx'), 'utf8')).toBe('mine');
    expect(fs.existsSync(path.join(folder, 'src', 'main.tsx'))).toBe(true);
  });
});

describe('a site and what it is built with', () => {
  it('gets the starter when it is a TypeScript site, and nothing but its record when it is plain', () => {
    const root = makeTempDir();
    cleanup.push(() => removeDir(root));
    const store = new SitesStore(root);
    const typed = store.create('Peach Palace', 'A bakery.', 'react-ts');
    expect(typed.stack).toBe('react-ts');
    expect(fs.existsSync(path.join(typed.folder, 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(typed.folder, 'src', 'main.tsx'))).toBe(true);
    expect(store.get('peach-palace')?.stack).toBe('react-ts');

    const plain = store.create('Plain One', '', 'plain');
    expect(plain.stack).toBe('plain');
    expect(fs.readdirSync(plain.folder)).toEqual(['.graft-site']);
    // Asked for nothing in particular: plain, as every site was before there was a choice.
    expect(store.create('Third', '').stack).toBe('plain');
    expect(store.list().map((s) => [s.slug, s.stack]).sort()).toEqual([['peach-palace', 'react-ts'], ['plain-one', 'plain'], ['third', 'plain']]);
  });

  it('reads a site from before there was a choice as a plain one, and keeps what it is built with when it changes', () => {
    const root = makeTempDir();
    cleanup.push(() => removeDir(root));
    writeFile(root, 'old-site/.graft-site/site.json', JSON.stringify({ name: 'Old site', description: '', createdAt: 1, updatedAt: 1, sessionId: null }));
    const store = new SitesStore(root);
    expect(store.get('old-site')?.stack).toBe('plain');
    const typed = store.create('Typed', '', 'react-ts');
    expect(store.update(typed.slug, { sessionId: 's1', touched: true })?.stack).toBe('react-ts');
    expect(store.get(typed.slug)?.stack).toBe('react-ts');
  });
});

describe('serving a site that is built', () => {
  async function served(): Promise<{ store: SitesStore; port: number; folder: string; host: string }> {
    const root = makeTempDir();
    const store = new SitesStore(root);
    const site = store.create('Peach Palace', '', 'react-ts');
    store.create('Plain One', '', 'plain');
    const server = new SiteServer(
      root,
      () => undefined,
      (slug) => {
        const found = store.get(slug);
        return found ? starterPage(found.name, found.stack) : null;
      },
      (slug) => store.get(slug)?.stack === 'react-ts'
    );
    const port = await server.start();
    cleanup.push(async () => {
      await server.close();
      removeDir(root);
    });
    return { store, port, folder: site.folder, host: `peach-palace.localhost:${port}` };
  }

  it('shows what the build made and nothing of the project around it', async () => {
    const { port, folder, host } = await served();
    // Before the first build there is a page that says what is going on, and the project is not on show.
    const waiting = await get(port, host);
    expect(waiting.status).toBe(200);
    expect(waiting.body).toContain('installing its packages and building');
    expect(waiting.body).toContain('/__graft/version');
    expect((await get(port, host, '/package.json')).status).toBe(404);
    expect((await get(port, host, '/src/main.tsx')).status).toBe(404);
    expect((await get(port, host, '/index.html')).status).toBe(404);

    writeFile(folder, 'dist/index.html', '<!doctype html><title>Peach Palace</title><body><div id="root"></div><script type="module" src="./assets/app.js"></script></body>');
    writeFile(folder, 'dist/assets/app.js', 'document.getElementById("root").textContent = "built";');
    writeFile(folder, 'node_modules/react/index.js', 'module.exports = {};');
    const page = await get(port, host);
    expect(page.status).toBe(200);
    expect(page.body).toContain('<div id="root"></div>');
    expect(page.body).toContain('/__graft/version');
    const script = await get(port, host, '/assets/app.js');
    expect(script.status).toBe(200);
    expect(script.type).toContain('text/javascript');
    for (const hidden of ['/package.json', '/src/main.tsx', '/src/App.tsx', '/node_modules/react/index.js', '/vite.config.ts', '/dist/index.html']) {
      expect((await get(port, host, hidden)).status, hidden).toBe(404);
    }
  });

  it('answers an address that names no file with the page itself, as an app of one page needs, and a missing file with 404', async () => {
    const { port, folder, host } = await served();
    writeFile(folder, 'dist/index.html', '<!doctype html><body><div id="root">app</div></body>');
    const deep = await get(port, host, '/pricing/teams');
    expect(deep.status).toBe(200);
    expect(deep.body).toContain('<div id="root">app</div>');
    expect((await get(port, host, '/assets/missing.css')).status).toBe(404);
    expect((await get(port, host, '/.env')).status).toBe(404);
    // A plain site has the pages it has: no page, no answer.
    writeFile(path.join(path.dirname(folder), 'plain-one'), 'index.html', '<h1>plain</h1>');
    expect((await get(port, `plain-one.localhost:${port}`, '/pricing')).status).toBe(404);
    expect((await get(port, `plain-one.localhost:${port}`)).body).toContain('<h1>plain</h1>');
  });

  it('tells open pages to reload after a build, and not after an edit to the source or an install', async () => {
    const { port, folder, host } = await served();
    writeFile(folder, 'dist/index.html', '<h1>one</h1>');
    const version = async (): Promise<string> => (await get(port, host, '/__graft/version')).body;
    const before = await version();
    await new Promise((resolve) => setTimeout(resolve, 150));
    writeFile(folder, 'src/App.tsx', 'export function App() { return null; }');
    writeFile(folder, 'node_modules/left-pad/index.js', 'x');
    writeFile(folder, 'package.json', '{}');
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(await version()).toBe(before);

    writeFile(folder, 'dist/assets/app.js', 'two');
    writeFile(folder, 'dist/index.html', '<h1>two</h1>');
    let after = before;
    for (let i = 0; i < 60 && after === before; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      after = await version();
    }
    expect(after).not.toBe(before);
    // One build is one reload: the files it writes one after another count once.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(Number(await version()) - Number(before)).toBe(1);
  });
});

describe('watching a site while its packages are installed', () => {
  it('settles what kind of site it is once, and does not ask again for every file an install writes', async () => {
    const root = makeTempDir();
    const store = new SitesStore(root);
    const site = store.create('Peach Palace', '', 'react-ts');
    let asked = 0;
    const server = new SiteServer(
      root,
      () => undefined,
      () => null,
      () => {
        asked++;
        return true;
      }
    );
    const port = await server.start();
    cleanup.push(async () => {
      await server.close();
      removeDir(root);
    });
    writeFile(site.folder, 'dist/index.html', '<h1>one</h1>');
    const host = `peach-palace.localhost:${port}`;
    const before = (await get(port, host, '/__graft/version')).body;
    await new Promise((resolve) => setTimeout(resolve, 150));
    const askedBefore = asked;
    for (let i = 0; i < 80; i++) writeFile(site.folder, `node_modules/some-package/lib/file${String(i)}.js`, 'x');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(asked - askedBefore).toBe(0);
    // None of it was a change to the site, although under such a burst the system may only say that something changed.
    expect((await get(port, host, '/__graft/version')).body).toBe(before);

    // A build that comes while packages are still landing is seen all the same: the built page itself has changed.
    for (let i = 0; i < 80; i++) writeFile(site.folder, `node_modules/another-package/lib/file${String(i)}.js`, 'x');
    writeFile(site.folder, 'dist/index.html', '<h1>two, and longer</h1>');
    let after = before;
    for (let i = 0; i < 60 && after === before; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      after = (await get(port, host, '/__graft/version')).body;
    }
    expect(after).not.toBe(before);
  });
});

describe('the brief for a site', () => {
  const ctx: CodePromptContext = {
    model: { label: 'Model', id: 'model-1', provider: 'Provider' },
    cwd: 'C:\\Users\\you\\Graft Sites\\peach-palace',
    projectRoot: 'C:\\Users\\you\\Graft Sites\\peach-palace',
    platform: 'win32',
    shellLabel: 'Git Bash',
    git: { isRepo: false, branch: null },
    date: '2026-10-12',
    mode: 'auto-edit',
    memory: [],
    skills: [],
    webSearch: false,
    mcpServers: []
  };
  const site = { name: 'Peach Palace', url: 'http://peach-palace.localhost:4870/' };

  it('asks for TypeScript, components and a build that passes when the site is a TypeScript one', () => {
    const prompt = buildCodeSystemPrompt({ ...ctx, site: { ...site, stack: 'react-ts' } });
    expect(prompt).toContain('# Website');
    expect(prompt).toContain('React and TypeScript');
    expect(prompt).toContain('npm install');
    expect(prompt).toContain('npm run build');
    expect(prompt).toContain('.tsx');
    expect(prompt).toMatch(/no `any`/i);
    expect(prompt).toContain('CSS module');
    expect(prompt).toContain('src/styles/tokens.css');
    expect(prompt).toMatch(/never invent a package name/i);
    expect(prompt).toContain('dist');
    expect(prompt).toContain('http://peach-palace.localhost:4870/');
    // Not the plain site's rules.
    expect(prompt).not.toContain('No build step');
  });

  it('asks for plain files and no build when the site is a plain one', () => {
    const prompt = buildCodeSystemPrompt({ ...ctx, site: { ...site, stack: 'plain' } });
    expect(prompt).toContain('# Website');
    expect(prompt).toContain('Plain HTML, CSS and JavaScript');
    expect(prompt).toContain('No build step');
    expect(prompt).not.toContain('npm install');
  });
});
