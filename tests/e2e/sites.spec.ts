import fs from 'node:fs';
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
});
