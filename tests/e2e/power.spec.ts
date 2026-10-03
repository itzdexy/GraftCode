import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchGraft, type LaunchedApp } from './support/launch';
import { MockProvider } from './support/mockProvider';
import { completeOnboarding, makeGitProject } from './support/onboard';

let provider: MockProvider;
let graft: LaunchedApp;
let project: string;

test.beforeEach(async () => {
  provider = await MockProvider.start();
  project = makeGitProject({ 'notes.txt': 'hello\n' });
  graft = await launchGraft();
  await completeOnboarding(graft, provider, { project });
});

test.afterEach(async () => {
  await graft.close();
  await provider.close();
});

function systemOf(request: { body: unknown }): string {
  const messages = (request.body as { messages: Array<{ role: string; content: unknown }> }).messages;
  return JSON.stringify(messages.find((m) => m.role === 'system')?.content ?? '');
}

test('the command palette runs app commands, and ">" in search switches to it', async () => {
  const w = graft.window;
  await w.keyboard.press('ControlOrMeta+Shift+P');
  const command = w.getByRole('combobox', { name: 'Command' });
  await expect(command).toBeVisible();
  await command.fill('palette midnight');
  await expect(w.getByRole('option', { name: /Palette: Midnight/ })).toBeVisible();
  await command.press('Enter');
  await expect(command).toBeHidden();
  await expect.poll(() => w.evaluate(() => document.documentElement.dataset.palette)).toBe('midnight');

  await w.keyboard.press('ControlOrMeta+K');
  await w.getByRole('combobox', { name: 'Search' }).fill('>');
  await expect(command).toBeVisible();
  await command.fill('settings personalization');
  await command.press('Enter');
  await expect(w.getByRole('heading', { name: 'Personalization', level: 2 })).toBeVisible();
});

test('personalization reaches the model, and /system shows the prompt a session sends', async () => {
  const w = graft.window;
  await w.keyboard.press('ControlOrMeta+Shift+P');
  await w.getByRole('combobox', { name: 'Command' }).fill('settings personalization');
  await w.keyboard.press('Enter');
  await w.getByRole('radio', { name: /Concise/ }).click();
  await w.getByLabel('What should Graft know about you?').fill('I maintain a Rust command-line tool.');
  await w.getByRole('button', { name: 'Save' }).click();
  await expect(w.getByText('Personalization saved')).toBeVisible();

  provider.script({ text: 'Noted.' });
  await w.keyboard.press('ControlOrMeta+N');
  const composer = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await composer.fill('hello');
  await composer.press('Enter');
  await expect(w.getByText('Noted.')).toBeVisible();
  const system = systemOf(provider.chatRequests()[0]!);
  expect(system).toContain('I maintain a Rust command-line tool.');
  expect(system).toContain('Response style: concise.');

  const box = w.getByRole('textbox', { name: /Ask anything/ });
  await box.fill('/system');
  await box.press('Enter');
  const dialog = w.getByRole('dialog', { name: 'System prompt' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/I maintain a Rust command-line tool\./)).toBeVisible();
  await expect(dialog.getByText('Edit', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Done' }).click();
  // No model request was made just to show it.
  expect(provider.chatRequests()).toHaveLength(1);
});

test('"!" runs a command in the session shell, and the next message carries its output', async () => {
  const w = graft.window;
  provider.script({ text: 'Ready.' }, { text: 'The log has one commit.' });
  const composer = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await composer.fill('get ready');
  await composer.press('Enter');
  await expect(w.getByText('Ready.')).toBeVisible();

  const box = w.getByRole('textbox', { name: /Ask anything/ });
  await box.fill('!git log --oneline');
  await expect(w.getByText(/Shell command: runs in this session/)).toBeVisible();
  await box.press('Enter');
  const card = w.getByRole('group', { name: 'You ran git log --oneline' });
  await expect(card).toBeVisible();
  await expect(card.getByText(/initial/)).toBeVisible();
  await expect(card.getByText(/^Done ·/)).toBeVisible();
  expect(provider.chatRequests()).toHaveLength(1);

  await box.fill('what does the log say?');
  await box.press('Enter');
  await expect(w.getByText('The log has one commit.')).toBeVisible();
  const sent = JSON.stringify(provider.chatRequests()[1]!.body);
  expect(sent).toContain('user-shell-command');
  expect(sent).toContain('initial');

  // Up brings back what was sent.
  await box.press('ArrowUp');
  await expect(box).toHaveValue('what does the log say?');
  await box.press('ArrowUp');
  await expect(box).toHaveValue('!git log --oneline');
  await box.press('ArrowDown');
  await box.press('ArrowDown');
  await expect(box).toHaveValue('');
});

test('a custom agent made from a template is saved in the project', async () => {
  const w = graft.window;
  await w.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Customize' }).click();
  await w.getByRole('tab', { name: 'Agents' }).click();
  await w.getByRole('button', { name: 'New agent' }).click();
  await w.getByRole('button', { name: 'Code reviewer' }).click();
  await w.getByRole('dialog', { name: 'New agent' }).getByRole('button', { name: 'Save' }).click();
  const row = w.getByRole('listitem').filter({ hasText: 'reviewer' });
  await expect(row).toBeVisible();
  await expect(row.getByText('4 tools')).toBeVisible();
  const file = path.join(project, '.graft', 'agents', 'reviewer.md');
  expect(fs.readFileSync(file, 'utf8')).toMatch(/^---\ndescription: .+\ntools: Read, Glob, Grep, Shell\n---\n\nYou review code changes/);
});
