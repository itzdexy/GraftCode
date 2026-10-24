import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchGraft, type LaunchedApp } from './support/launch';
import { MockProvider } from './support/mockProvider';
import { completeOnboarding } from './support/onboard';

let provider: MockProvider;
let graft: LaunchedApp;

test.beforeEach(async () => {
  provider = await MockProvider.start();
  graft = await launchGraft();
  await completeOnboarding(graft, provider);
});

test.afterEach(async () => {
  await graft.close();
  await provider.close();
});

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Peach Palace</title></head>
<body><h1>Peach Palace</h1><p>Seasonal bakes, made by hand.</p></body></html>
`;

test('a site is built from a description, hosted locally and shown in the gallery', async () => {
  const w = graft.window;
  provider.titleText = 'Peach Palace site';
  provider.script(
    { text: 'Designing the bakery site.', toolCalls: [{ name: 'Write', input: { file_path: 'index.html', content: PAGE } }] },
    { text: 'Peach Palace is live: a warm one-page site with the menu up front.' }
  );

  await w.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Sites' }).click();
  await expect(w.getByRole('heading', { name: 'Sites', level: 1 })).toBeVisible();
  await w.getByRole('textbox', { name: 'Describe your site' }).fill('A warm website for my bakery called Peach Palace, with the menu and opening hours.');
  // Plain files, served as they are: the choice is offered beside the name, and a TypeScript project is what it starts on.
  await w.getByRole('radiogroup', { name: 'Built with' }).getByRole('radio', { name: 'Plain HTML' }).click();
  await expect(w.getByText('No build, nothing to install.')).toBeVisible();
  await w.getByRole('button', { name: 'Build site' }).click();

  // The session opens with the live preview, and the agent writes the page without asking (Auto-edit).
  await expect(w.getByText('Peach Palace is live')).toBeVisible({ timeout: 30_000 });
  await expect(w.getByRole('alertdialog')).toHaveCount(0);
  const panel = w.getByRole('region', { name: 'Browser' });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('textbox', { name: 'Address' })).toHaveValue(/^http:\/\/peach-palace\.localhost:\d+\/$/);

  const folder = path.join(graft.graftHome, 'sites', 'peach-palace');
  expect(fs.readFileSync(path.join(folder, 'index.html'), 'utf8')).toBe(PAGE);
  // The model was told where the site lives and how to check it.
  const system = (provider.chatRequests()[0]!.body as { messages: Array<{ role: string; content: unknown }> }).messages[0]!;
  expect(JSON.stringify(system)).toContain('# Website');
  expect(JSON.stringify(system)).toMatch(/peach-palace\.localhost:\d+/);

  // The gallery lists it, with a picture taken after the turn.
  await w.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Sites' }).click();
  const card = w.getByRole('button', { name: 'Open Peach Palace' });
  await expect(card).toBeVisible();
  await expect(card.locator('img')).toBeVisible({ timeout: 20_000 });
  expect(fs.existsSync(path.join(folder, '.graft-site', 'thumbnail.png'))).toBe(true);
  // The gallery says what it is built with (the mark sits beside the picture, in the site's row of the list).
  await expect(w.getByRole('listitem').filter({ has: card }).getByText('HTML', { exact: true })).toBeVisible();
});

/** A page of a site, asked for as a browser would: at the loopback address, under the site's own name. */
function fetchSite(address: string, urlPath: string): Promise<{ status: number; body: string }> {
  const { host, port } = new URL(address);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, headers: { host }, agent: false }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString('utf8')));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const BUILT = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Peach Palace</title></head>
<body><div id="root"><h1>Peach Palace</h1></div></body></html>
`;

test('a TypeScript site starts as a project, is briefed as one, and shows what its build made', async () => {
  const w = graft.window;
  provider.titleText = 'Peach Palace site';
  // No packages can be installed in a test, so the model's part is scripted: it writes what a build would have put in dist.
  provider.script(
    { text: 'Building the bakery site.', toolCalls: [{ name: 'Write', input: { file_path: 'dist/index.html', content: BUILT } }] },
    { text: 'Peach Palace is built: components for the menu and the hours.' }
  );

  await w.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Sites' }).click();
  await w.getByRole('textbox', { name: 'Describe your site' }).fill('A warm website for my bakery called Peach Palace, with the menu and opening hours.');
  // A project is what a site is built as unless plain files are chosen (this computer has npm: the tests run on it).
  const choice = w.getByRole('radiogroup', { name: 'Built with' });
  await expect(choice.getByRole('radio', { name: 'React + TypeScript' })).toHaveAttribute('aria-checked', 'true');
  await expect(w.getByText(/Graft asks before it installs packages or builds/)).toBeVisible();
  await w.getByRole('button', { name: 'Build site' }).click();
  await expect(w.getByText('Peach Palace is built')).toBeVisible({ timeout: 30_000 });

  // The folder holds a project, with the site's name in it, before the model has written a line.
  const folder = path.join(graft.graftHome, 'sites', 'peach-palace');
  const pkg = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8')) as { name: string; scripts: Record<string, string>; dependencies: Record<string, string> };
  expect(pkg.name).toBe('peach-palace');
  expect(pkg.scripts.build).toBe('tsc --noEmit && vite build');
  expect(Object.keys(pkg.dependencies)).toEqual(['react', 'react-dom']);
  for (const file of ['tsconfig.json', 'vite.config.ts', 'index.html', 'src/main.tsx', 'src/App.tsx', 'src/styles/tokens.css']) expect(fs.existsSync(path.join(folder, file)), file).toBe(true);
  expect(fs.readFileSync(path.join(folder, 'src', 'App.tsx'), 'utf8')).toContain('const NAME = "Peach Palace";');
  expect((JSON.parse(fs.readFileSync(path.join(folder, '.graft-site', 'site.json'), 'utf8')) as { stack: string }).stack).toBe('react-ts');

  // The model was briefed for a project: install once, build to show a change, TypeScript as a team writes it.
  const system = JSON.stringify((provider.chatRequests()[0]!.body as { messages: Array<{ role: string; content: unknown }> }).messages[0]!);
  expect(system).toContain('# Website');
  expect(system).toContain('React and TypeScript');
  expect(system).toContain('npm run build');
  expect(system).not.toContain('No build step');

  // What is on show is what the build made, and nothing of the project around it.
  const panel = w.getByRole('region', { name: 'Browser' });
  await expect(panel.getByRole('textbox', { name: 'Address' })).toHaveValue(/^http:\/\/peach-palace\.localhost:\d+\/$/);
  const address = await panel.getByRole('textbox', { name: 'Address' }).inputValue();
  const page = await fetchSite(address, '/');
  expect(page.status).toBe(200);
  expect(page.body).toContain('<div id="root"><h1>Peach Palace</h1></div>');
  expect((await fetchSite(address, '/package.json')).status).toBe(404);
  expect((await fetchSite(address, '/src/main.tsx')).status).toBe(404);
  expect((await fetchSite(address, '/menu')).body).toContain('<div id="root">');

  // The gallery says what it is built with.
  await w.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Sites' }).click();
  const card = w.getByRole('listitem').filter({ has: w.getByRole('button', { name: 'Open Peach Palace' }) });
  await expect(card.getByText('TypeScript', { exact: true })).toBeVisible();
  // The choice is remembered for the next site.
  await expect(w.getByRole('radiogroup', { name: 'Built with' }).getByRole('radio', { name: 'React + TypeScript' })).toHaveAttribute('aria-checked', 'true');
});
