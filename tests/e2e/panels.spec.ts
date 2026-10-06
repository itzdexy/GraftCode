import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchGraft, type LaunchedApp } from './support/launch';
import { MockProvider } from './support/mockProvider';
import { completeOnboarding, makeGitProject } from './support/onboard';
import { solidPng } from './support/png';

const SHOTS = path.join(__dirname, '..', '..', 'test-results', 'shots');

async function shot(w: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true });
  await w.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

let provider: MockProvider;
let graft: LaunchedApp;
let project: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: project, encoding: 'utf8' });
}

test.beforeEach(async () => {
  provider = await MockProvider.start();
  project = makeGitProject({ 'notes.txt': 'hello\n', 'src/app.ts': 'export const x = 1;\n' });
  graft = await launchGraft();
  await completeOnboarding(graft, provider, { project });
  provider.script({ text: 'Ready.' });
  const composer = graft.window.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await composer.fill('Get ready');
  await composer.press('Enter');
  await expect(graft.window.getByText('Ready.', { exact: true })).toBeVisible();
});

test.afterEach(async () => {
  await graft.close();
  await provider.close();
});

test('the terminal panel runs a real shell in the project folder', async () => {
  const w = graft.window;
  const env = await w.evaluate(async () => {
    const bridge = (window as unknown as { graft: { invoke(c: string): Promise<{ value: { shell: { kind: string } } }> } }).graft;
    return (await bridge.invoke('app:environment')).value;
  });
  await w.getByRole('button', { name: 'Terminal', exact: true }).click();
  const panel = w.getByRole('region', { name: 'Terminal' });
  await expect(panel.getByRole('tab', { name: /1 ·/ })).toBeVisible();
  const screen = panel.locator('.xterm-rows');
  await expect(screen).not.toBeEmpty();
  await panel.locator('.xterm').click();
  const command = env.shell.kind === 'powershell' ? 'Write-Output "graft-$(40+2)"; (Get-Location).Path' : 'echo graft-$((40+2)); pwd -W';
  await w.keyboard.type(command);
  await w.keyboard.press('Enter');
  await expect(screen).toContainText('graft-42');
  // The shell starts in the session's folder.
  const folder = path.basename(project);
  await expect(screen).toContainText(folder);
  await shot(w, 'panel-terminal');

  // Closing and reopening the panel keeps the terminal and its scrollback.
  await w.getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(panel).toBeHidden();
  await w.keyboard.press('Control+`');
  await expect(w.getByRole('region', { name: 'Terminal' }).locator('.xterm-rows')).toContainText('graft-42');
});

test('the changes panel stages, unstages by hunk, discards and commits', async () => {
  const w = graft.window;
  fs.writeFileSync(path.join(project, 'notes.txt'), 'hello world\n');
  fs.writeFileSync(path.join(project, 'scratch.txt'), 'temporary\n');

  await w.keyboard.press('Control+Shift+D');
  const panel = w.getByRole('region', { name: 'Changes', exact: true });
  await expect(panel.getByText('2 changed files on main')).toBeVisible();
  const unstaged = panel.getByRole('region', { name: 'Unstaged changes', exact: true });
  await expect(unstaged.getByRole('button', { name: /^notes\.txt \(/ })).toBeVisible();
  await expect(unstaged.getByRole('button', { name: /^scratch\.txt \(/ })).toBeVisible();

  // Stage one file.
  await unstaged.getByRole('button', { name: /^notes\.txt \(/ }).hover();
  await unstaged.getByRole('button', { name: 'Stage notes.txt' }).click();
  const staged = panel.getByRole('region', { name: 'Staged changes', exact: true });
  await expect(staged.getByRole('button', { name: /^notes\.txt \(/ })).toBeVisible();
  expect(git('diff', '--cached', '--name-only').trim()).toBe('notes.txt');

  // Its diff shows the change; unstage that hunk.
  await staged.getByRole('button', { name: /^notes\.txt \(/ }).click();
  await expect(panel.getByText('hello world', { exact: true })).toBeVisible();
  await shot(w, 'panel-changes');
  await panel.getByRole('button', { name: 'Unstage', exact: true }).click();
  await expect(staged).toBeHidden();
  expect(git('diff', '--cached', '--name-only').trim()).toBe('');

  // Discarding an untracked file asks first, then deletes it.
  await unstaged.getByRole('button', { name: /^scratch\.txt \(/ }).hover();
  await unstaged.getByRole('button', { name: 'Discard changes to scratch.txt' }).click();
  const confirm = w.getByRole('dialog', { name: 'Discard changes to scratch.txt?' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Discard' }).click();
  await expect(unstaged.getByRole('button', { name: /^scratch\.txt \(/ })).toBeHidden();
  expect(fs.existsSync(path.join(project, 'scratch.txt'))).toBe(false);

  // Commit everything that's left.
  await panel.getByRole('textbox', { name: 'Commit message' }).fill('Say hello to the world');
  await panel.getByRole('button', { name: 'Commit all' }).click();
  await expect(panel.getByText('No changes on main')).toBeVisible();
  expect(git('log', '-1', '--format=%s').trim()).toBe('Say hello to the world');
  expect(git('status', '--porcelain').trim()).toBe('');

  // The Files tab browses the folder read-only with a preview.
  await panel.getByRole('tab', { name: 'Files' }).click();
  await panel.getByRole('treeitem', { name: /src/ }).getByRole('button').first().click();
  await panel.getByRole('treeitem', { name: /app\.ts/ }).getByRole('button', { name: /^app\.ts/ }).click();
  await expect(panel.getByText('export const x = 1;')).toBeVisible();
  await shot(w, 'panel-files');
});

test('the browser panel opens local pages and blocks non-web addresses', async () => {
  const w = graft.window;
  await w.getByRole('button', { name: 'Browser' }).click();
  const panel = w.getByRole('region', { name: 'Browser' });
  await panel.getByRole('textbox', { name: 'Address' }).fill('file:///C:/Windows/win.ini');
  await panel.getByRole('textbox', { name: 'Address' }).press('Enter');
  await expect(w.getByText(/Only http and https addresses/)).toBeVisible();

  await panel.getByRole('textbox', { name: 'Address' }).fill(provider.url.replace('/v1', '/v1/models'));
  await panel.getByRole('textbox', { name: 'Address' }).press('Enter');
  await expect(panel.getByRole('textbox', { name: 'Address' })).toHaveValue(/(127\.0\.0\.1|\[::1\]|localhost):\d+\/v1\/models/);
  const page = await graft.app.evaluate(async ({ webContents }) => {
    const panelContents = webContents.getAllWebContents().find((c) => c.getURL().includes('/v1/models'));
    if (!panelContents) return null;
    const text: unknown = await panelContents.executeJavaScript('document.body.innerText');
    const hasBridge: unknown = await panelContents.executeJavaScript('typeof window.graft');
    return { text: String(text), hasBridge: String(hasBridge) };
  });
  expect(page?.text).toContain('graft-test-large');
  // No preload: the page can't reach Graft's bridge.
  expect(page?.hasBridge).toBe('undefined');
  await shot(w, 'panel-browser');
});

test('the files panel shows a picture with its size, and the Read step shows it too; its path, itself and a mention can be taken from it', async () => {
  const w = graft.window;
  fs.mkdirSync(path.join(project, 'art'));
  fs.writeFileSync(path.join(project, 'art', 'picture.png'), solidPng(48, 32, [47, 111, 79]));
  fs.writeFileSync(path.join(project, 'art', 'run.bat'), '@echo off\n');

  await w.getByRole('button', { name: 'More actions' }).click();
  await w.getByRole('menuitem', { name: /^Files/ }).click();
  const panel = w.getByRole('region', { name: 'Changes', exact: true });
  await panel.getByRole('button', { name: 'art', exact: true }).click();
  await panel.getByRole('button', { name: /^picture\.png/ }).click();

  // The picture itself, not "binary file" or "too large to preview", with its size in pixels once it has loaded.
  const picture = panel.getByRole('img', { name: 'Preview of picture.png' });
  await expect(picture).toBeVisible();
  await expect.poll(() => picture.evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight])).toEqual([48, 32]);
  await expect(panel.getByText(/48 × 32 · \d+ B/)).toBeVisible();
  await shot(w, 'panel-files-picture');

  // Where it is: the full path, the way this computer writes paths.
  await panel.getByRole('button', { name: 'Copy path' }).click();
  await expect(w.getByText('Path copied')).toBeVisible();
  expect(await graft.app.evaluate(({ clipboard }) => clipboard.readText())).toBe(path.join(project, 'art', 'picture.png'));

  // The file's menu: the picture itself goes on the clipboard, and the file can be mentioned in the message.
  await panel.getByRole('button', { name: 'Options for picture.png' }).last().click();
  await expect(w.getByRole('menuitem', { name: 'Copy relative path' })).toBeVisible();
  await expect(w.getByRole('menuitem', { name: 'Show in folder' })).toBeVisible();
  await expect(w.getByRole('menuitem', { name: 'Open with its app' })).toBeVisible();
  await w.getByRole('menuitem', { name: 'Copy picture' }).click();
  await expect(w.getByText('Picture copied')).toBeVisible();
  const kinds = await graft.app.evaluate(async ({ clipboard }) => (await clipboard.read()).flatMap((item) => item.types));
  expect(kinds).toContain('image/png');

  await panel.getByRole('button', { name: 'Options for picture.png' }).last().click();
  await w.getByRole('menuitem', { name: 'Add to message' }).click();
  const box = w.getByRole('combobox', { name: /^Ask anything/ }).or(w.getByRole('textbox', { name: /^Ask anything/ }));
  await expect(box).toHaveValue('@art/picture.png ');

  // Something a click could run is never offered to be opened.
  await panel.getByRole('button', { name: /^run\.bat/ }).click({ button: 'right' });
  await expect(w.getByRole('menuitem', { name: 'Copy path' })).toBeVisible();
  await expect(w.getByRole('menuitem', { name: 'Open with its app' })).toHaveCount(0);
  await expect(w.getByRole('menuitem', { name: 'Copy picture' })).toHaveCount(0);
  await w.keyboard.press('Escape');

  // The agent reads the picture: the step in the transcript shows it, with the same actions.
  provider.script({ toolCalls: [{ name: 'Read', input: { file_path: 'art/picture.png' } }] }, { text: 'It is a small green picture.' });
  await box.fill('Look at art/picture.png');
  await box.press('Enter');
  await expect(w.getByText('It is a small green picture.', { exact: true })).toBeVisible();
  await w.getByRole('button', { name: /^Read picture\.png/ }).first().click();
  const step = w.getByRole('button', { name: /^Read picture\.png/ }).last();
  if ((await step.getAttribute('aria-expanded')) === 'false') await step.click();
  const read = w.getByRole('img', { name: 'The picture picture.png' });
  await expect(read).toBeVisible();
  await expect.poll(() => read.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(48);
  await shot(w, 'transcript-read-picture');
});
