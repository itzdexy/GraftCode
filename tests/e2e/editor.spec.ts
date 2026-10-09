import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchGraft, type LaunchedApp } from './support/launch';
import { MockProvider } from './support/mockProvider';
import { completeOnboarding, makeGitProject } from './support/onboard';

let graft: LaunchedApp | undefined;
let provider: MockProvider | undefined;
test.afterEach(async () => { await graft?.close(); await provider?.close(); });

test('Monaco edits and keyboard saves actual files while keeping drafts on destination conflicts', async () => {
  const project = makeGitProject({ 'notes.txt': 'before\r\n', 'other.txt': 'other\n' });
  provider = await MockProvider.start(); graft = await launchGraft();
  await completeOnboarding(graft, provider, { project });
  const w = graft.window;
  provider.script({ text: 'Editor ready.' });
  const composer = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await composer.fill('Open the project'); await composer.press('Enter');
  await expect(w.getByText('Editor ready.', { exact: true })).toBeVisible();
  await w.getByRole('button', { name: 'More actions' }).click();
  await w.getByRole('menuitem', { name: /^Files/ }).click();
  await w.getByRole('tree', { name: 'Files' }).getByRole('button', { name: /^notes.txt/ }).first().click();
  await w.getByRole('button', { name: 'Edit file', exact: true }).click();
  const editor = w.getByRole('textbox', { name: 'Edit notes.txt' });
  await expect(editor).toBeVisible();
  await editor.focus(); await w.keyboard.press('Control+A'); await w.keyboard.type('saved'); await w.keyboard.press('Control+S');
  await expect.poll(() => fs.readFileSync(path.join(project, 'notes.txt'), 'utf8')).toBe('saved');
  await expect(w.getByLabel('Unsaved changes', { exact: true })).toHaveCount(0);
  await w.keyboard.press('Control+A'); await w.keyboard.type('private draft');
  await expect(w.getByLabel('Unsaved changes', { exact: true })).toBeVisible();
  fs.writeFileSync(path.join(project, 'notes.txt'), 'external change');
  await w.keyboard.press('Control+S');
  await expect(w.getByRole('alert').filter({ hasText: /changed on disk/ })).toBeVisible();
  expect(fs.readFileSync(path.join(project, 'notes.txt'), 'utf8')).toBe('external change');
  // Switching files keeps the dirty buffer and its original revision in memory.
  await w.getByRole('tree', { name: 'Files' }).getByRole('button', { name: /^other.txt/ }).first().click();
  await w.getByRole('tree', { name: 'Files' }).getByRole('button', { name: /^notes.txt/ }).first().click();
  await expect(w.getByLabel('Unsaved changes', { exact: true })).toBeVisible();
  await w.getByRole('button', { name: 'Edit file', exact: true }).click();
  await expect(w.locator('.monaco-editor .view-lines')).toContainText('private draft');
  await w.getByRole('button', { name: 'Save file', exact: true }).click();
  await expect(w.getByRole('alert').filter({ hasText: /changed on disk/ })).toBeVisible();
  await w.getByRole('button', { name: 'Discard draft and reload', exact: true }).click();
  await expect(w.getByLabel('Unsaved changes', { exact: true })).toHaveCount(0);
  await expect(w.getByText('external change', { exact: true })).toBeVisible();
  await w.screenshot({ path: test.info().outputPath('editor-recovery.png') });
});

test('unsaved recovery survives an app restart and keeps the original conflict guard and a deleted file buffer', async () => {
  const project = makeGitProject({ 'notes.txt': 'original' });
  provider = await MockProvider.start(); graft = await launchGraft();
  await completeOnboarding(graft, provider, { project });
  let w = graft.window;
  provider.script({ text: 'Persistent editor ready.' });
  const composer = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await composer.fill('Open notes'); await composer.press('Enter');
  await expect(w.getByText('Persistent editor ready.', { exact: true })).toBeVisible();
  await w.getByRole('button', { name: 'More actions' }).click(); await w.getByRole('menuitem', { name: /^Files/ }).click();
  await w.getByRole('tree', { name: 'Files' }).getByRole('button', { name: /^notes.txt/ }).first().click();
  await w.getByRole('button', { name: 'Edit file', exact: true }).click();
  await w.getByRole('textbox', { name: 'Edit notes.txt' }).focus();
  await w.keyboard.press('Control+A'); await w.keyboard.type('restart recovery draft');
  await expect(w.getByRole('status').filter({ hasText: 'Draft backed up on this device.' })).toBeVisible();
  expect(fs.readFileSync(path.join(project, 'notes.txt'), 'utf8')).toBe('original');
  const { userData, graftHome } = graft; await graft.close(); graft = undefined;
  fs.writeFileSync(path.join(project, 'notes.txt'), 'external while closed');
  graft = await launchGraft({ userData, graftHome }); w = graft.window;
  await w.getByText('Scripted title', { exact: true }).first().click();
  await expect(w.getByText('Persistent editor ready.', { exact: true })).toBeVisible();
  await w.getByRole('button', { name: 'More actions' }).click(); await w.getByRole('menuitem', { name: /^Files/ }).click();
  await w.getByRole('button', { name: 'Open draft notes.txt', exact: true }).click();
  await expect(w.getByRole('textbox', { name: 'Edit notes.txt' })).toBeVisible();
  await expect(w.locator('.monaco-editor .view-lines')).toContainText('restart recovery draft');
  await w.getByRole('button', { name: 'Save file', exact: true }).click();
  await expect(w.getByRole('alert').filter({ hasText: /changed on disk/ })).toBeVisible();
  expect(fs.readFileSync(path.join(project, 'notes.txt'), 'utf8')).toBe('external while closed');
  fs.unlinkSync(path.join(project, 'notes.txt'));
  await w.getByRole('button', { name: 'Open draft notes.txt', exact: true }).click();
  await expect(w.getByRole('textbox', { name: 'Edit notes.txt' })).toBeVisible();
  await expect(w.locator('.monaco-editor .view-lines')).toContainText('restart recovery draft');
  await expect(w.getByRole('alert').filter({ hasText: /recovered draft is kept/ })).toBeVisible();
});

test('editor type checks unsaved drafts only after project trust and F12 opens the real definition', async () => {
  const original = 'import { twice as double } from "./library";\nexport const answer = double(21);\n';
  const project = makeGitProject({ 'main.ts': original, 'library.ts': 'export function twice(value: number): number { return value * 2; }\n',
    'tsconfig.json': '{"compilerOptions":{"strict":true,"target":"ES2022","module":"commonjs"}}' });
  provider = await MockProvider.start(); graft = await launchGraft();
  await completeOnboarding(graft, provider, { project });
  const w = graft.window;
  provider.script({ text: 'Language editor ready.' });
  const composer = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await composer.fill('Inspect the project'); await composer.press('Enter');
  await expect(w.getByText('Language editor ready.', { exact: true })).toBeVisible();
  await w.getByRole('button', { name: 'More actions' }).click();
  await w.getByRole('menuitem', { name: /^Files/ }).click();
  await w.getByRole('tree', { name: 'Files' }).getByRole('button', { name: /^main.ts/ }).first().click();
  await w.getByRole('button', { name: 'Edit file', exact: true }).click();
  await w.getByRole('button', { name: 'Check types', exact: true }).click();
  await expect(w.getByRole('alert').filter({ hasText: /requires a trusted/ })).toBeVisible();
  await w.evaluate(async (folder) => {
    const bridge = (window as unknown as { graft: { invoke(channel: string, input?: unknown): Promise<{ ok: boolean; value: Array<{ id: string; path: string }> }> } }).graft;
    const selected = (await bridge.invoke('projects:list')).value.find((p) => p.path === folder);
    if (!selected || !(await bridge.invoke('projects:update', { id: selected.id, trusted: true })).ok) throw new Error('Could not trust editor fixture');
  }, project);
  const editor = w.getByRole('textbox', { name: 'Edit main.ts' });
  await editor.focus(); await w.keyboard.press('Control+A'); await w.keyboard.type(original.replace('double(21)', 'double("bad")'));
  await w.keyboard.press('Control+Shift+M');
  await expect(w.getByRole('list', { name: 'Type diagnostics' })).toContainText('TS2345');
  expect(fs.readFileSync(path.join(project, 'main.ts'), 'utf8')).toBe(original);
  for (const size of [{ width: 900, height: 600 }, { width: 1920, height: 1080 }]) {
    await graft.app.evaluate(({ BrowserWindow }, dimensions) => { const win = BrowserWindow.getAllWindows()[0]; win?.unmaximize(); win?.setContentSize(dimensions.width, dimensions.height); }, size);
    await expect.poll(() => w.evaluate(() => [innerWidth, innerHeight])).toEqual([size.width, size.height]);
    await expect(w.getByRole('button', { name: 'Check types', exact: true })).toBeInViewport();
    await expect(editor).toBeInViewport();
    expect(await w.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await w.screenshot({ path: test.info().outputPath(`editor-diagnostics-${size.width}.png`) });
  }
  await editor.focus(); await w.keyboard.press('Control+A'); await w.keyboard.type(original);
  await w.keyboard.press('Control+Shift+M');
  await expect(w.getByRole('status').filter({ hasText: 'Type check complete: 0 issues.' })).toBeVisible();
  await editor.focus(); await w.keyboard.press('Control+Home'); await w.keyboard.press('ArrowDown'); await w.keyboard.press('Home');
  for (let i = 0; i < 22; i++) await w.keyboard.press('ArrowRight');
  await w.keyboard.press('F12');
  await expect(w.getByRole('textbox', { name: 'Edit library.ts' })).toBeVisible();
  await expect(w.locator('.monaco-editor .view-lines')).toContainText('export function twice');
});
