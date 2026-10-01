import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchGraft, type LaunchedApp } from './support/launch';
import { MockProvider } from './support/mockProvider';
import { completeOnboarding, makeGitProject } from './support/onboard';

const SHOTS = path.join(__dirname, '..', '..', 'test-results', 'shots');
async function shot(w: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true });
  await w.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

let provider: MockProvider;
let graft: LaunchedApp;
let project: string;

test.beforeEach(async () => {
  provider = await MockProvider.start();
  project = makeGitProject();
  graft = await launchGraft();
  await completeOnboarding(graft, provider, { project });
});

test.afterEach(async () => {
  await graft.close();
  await provider.close();
});

async function openNav(w: Page, label: string): Promise<void> {
  const nav = w.getByRole('navigation', { name: 'Main' });
  const item = nav.getByRole('button', { name: label, exact: true });
  if (!(await item.isVisible())) await nav.getByRole('button', { name: 'More' }).click();
  await item.click();
}

test('artifacts list files the agent wrote and preview HTML in a sandbox', async () => {
  const w = graft.window;
  provider.script(
    { toolCalls: [{ name: 'Write', input: { file_path: 'site/index.html', content: '<!doctype html><h1 id="t">Hello artifact</h1><script>document.title = "ran";</script>' } }] },
    { text: 'Made a page.' }
  );
  await w.getByRole('button', { name: /Permission mode/ }).click();
  await w.getByRole('menuitem', { name: /Auto-edit/ }).click();
  const composer = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await composer.fill('Make a page');
  await composer.press('Enter');
  await expect(w.getByText('Made a page.')).toBeVisible();

  await openNav(w, 'Artifacts');
  await expect(w.getByRole('list', { name: 'Artifacts' }).getByText('index.html')).toBeVisible();
  const frame = w.frameLocator('iframe[title="Preview of index.html"]');
  await expect(frame.locator('#t')).toHaveText('Hello artifact');
  // The page ran in an opaque, sandboxed origin: it cannot reach Graft's bridge.
  const sandbox = await w.locator('iframe[title="Preview of index.html"]').getAttribute('sandbox');
  expect(sandbox).toBe('allow-scripts');
  const bridgeVisible = await frame.locator('body').evaluate(() => 'graft' in window);
  expect(bridgeVisible).toBe(false);
  await shot(w, 'artifacts');
});

test('a text file attached in the composer reaches the model and shows as a chip', async () => {
  const w = graft.window;
  provider.script({ text: 'Read your file.' });
  await w.locator('input[type="file"]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('the secret word is teal') });
  const attachments = w.getByRole('list', { name: 'Attachments' });
  await expect(attachments.getByText('notes.txt')).toBeVisible();
  const composer = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await composer.fill('Summarize the file');
  await composer.press('Enter');
  await expect(w.getByText('Read your file.')).toBeVisible();
  await expect(w.getByRole('main').getByText('notes.txt')).toBeVisible();
  const turn = provider.chatRequests().map((r) => JSON.stringify(r.body)).find((b) => b.includes('Summarize the file'));
  expect(turn).toContain('<attached-file name=\\"notes.txt\\">');
  expect(turn).toContain('the secret word is teal');
});

test('projects show trust and defaults; schedules start sessions on demand', async () => {
  const w = graft.window;
  await openNav(w, 'Projects');
  const row = w.getByRole('listitem').filter({ hasText: path.basename(project) });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: /Options for/ }).click();
  await w.getByRole('menuitem', { name: /Trust this project/ }).click();
  await expect(row.getByText('Trusted')).toBeVisible();
  await shot(w, 'projects');

  provider.script({ text: 'Scheduled work done.' });
  await openNav(w, 'Scheduled');
  await w.getByRole('button', { name: 'New schedule' }).click();
  const dialog = w.getByRole('dialog', { name: 'New schedule' });
  await dialog.getByLabel('Name').fill('Morning check');
  await dialog.getByLabel('What should the session do?').fill('Say hello');
  await dialog.getByRole('radio', { name: 'Weekdays' }).click();
  await expect(dialog.getByText(/Weekdays at 09:00 · next run/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Create schedule' }).click();
  await expect(dialog).toBeHidden();
  const schedule = w.getByRole('listitem').filter({ hasText: 'Morning check' });
  await expect(schedule.getByText(/Weekdays at 09:00/)).toBeVisible();
  await shot(w, 'scheduled');

  await schedule.getByRole('button', { name: 'Run now' }).click();
  await expect(schedule.getByRole('button', { name: /Last run/ })).toBeVisible();
  await schedule.getByRole('button', { name: /Last run/ }).click();
  await expect(w.getByText('Scheduled work done.')).toBeVisible();
  await expect(w.getByRole('navigation', { name: 'Main' }).getByText(/^Morning check ·/)).toBeVisible();
});
