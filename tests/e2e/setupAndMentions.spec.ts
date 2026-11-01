import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchGraft, type LaunchedApp } from './support/launch';
import { MockProvider, requestText } from './support/mockProvider';
import { completeOnboarding, makeGitProject } from './support/onboard';

const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'mcp-test-server.mjs');
const SHOTS = path.join(__dirname, '..', '..', 'test-results', 'shots');
/** The message box of a code session with a project folder, by its label. */
const SESSION_BOX = /^Ask anything/;

let provider: MockProvider | undefined;
let graft: LaunchedApp | undefined;

test.afterEach(async () => {
  await graft?.close();
  await provider?.close();
});

/** Starts Graft in a new project with these files; `trusted` marks the project as one whose own settings apply. */
async function start(files: Record<string, string>, trusted: boolean): Promise<{ w: Page; model: MockProvider; project: string }> {
  const model = await MockProvider.start();
  provider = model;
  const project = makeGitProject(files);
  const app = await launchGraft();
  graft = app;
  await completeOnboarding(app, model, { project });
  if (trusted) {
    await app.window.evaluate(async (folder) => {
      const bridge = (window as unknown as { graft: { invoke(channel: string, input?: unknown): Promise<{ ok: boolean; value: Array<{ id: string; path: string }> }> } }).graft;
      const projects = (await bridge.invoke('projects:list')).value;
      const selected = projects.find((item) => item.path === folder);
      if (!selected || !(await bridge.invoke('projects:update', { id: selected.id, trusted: true })).ok) throw new Error('Could not trust the project');
    }, project);
  }
  return { w: app.window, model, project };
}

/** Sends a first message, so the session and its folder are on screen; returns its message box. */
async function open(w: Page, model: MockProvider) {
  model.script({ text: 'Hi.' });
  await w.getByRole('textbox', { name: 'Describe a task or ask a question' }).fill('hello');
  await w.keyboard.press('Enter');
  await expect(w.getByText('Hi.', { exact: true })).toBeVisible();
  return w.getByRole('combobox', { name: SESSION_BOX }).or(w.getByRole('textbox', { name: SESSION_BOX }));
}

async function shot(w: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true });
  await w.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

test("a trusted project's .claude/commands shows in the slash menu and runs as a command", async () => {
  const { w, model } = await start({ 'notes.txt': 'hello\n', '.claude/commands/hello.md': '---\ndescription: Greet someone from the imported command\n---\nSay hello to $ARGUMENTS, from the imported command.\n' }, true);
  const box = await open(w, model);

  await box.fill('/hel');
  const list = w.getByRole('listbox', { name: 'Commands' });
  await expect(list.getByRole('option', { name: /\/hello.*Greet someone from the imported command/ })).toBeVisible();
  await shot(w, 'setup-imported-command');

  model.script({ text: 'Greeted.' });
  await box.fill('/hello the whole team');
  await box.press('Enter');
  await expect(w.getByText('Greeted.', { exact: true })).toBeVisible();
  // The transcript shows what was typed; the model gets the command's text with the arguments in place.
  await expect(w.getByText('/hello the whole team')).toBeVisible();
  expect(requestText(model.chatRequests().at(-1)?.body)).toContain('Say hello to the whole team, from the imported command.');

  // Customize lists it as the other tool's, where it is, without Edit or Delete.
  await w.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Customize' }).click();
  await expect(w.getByText('/hello', { exact: true })).toBeVisible();
  await expect(w.getByText('.claude', { exact: true })).toBeVisible();
  await expect(w.getByRole('button', { name: 'Copy /hello to Graft' })).toBeVisible();
  await expect(w.getByRole('button', { name: 'Edit /hello' })).toHaveCount(0);
});

test('a server in the project’s .mcp.json is offered by Import and can be added', async () => {
  const mcpJson = { mcpServers: { fixture: { command: process.execPath, args: [FIXTURE], env: { FIXTURE_API_TOKEN: 'kept-out-of-settings-123' } } } };
  const { w, project } = await start({ 'notes.txt': 'hello\n', '.mcp.json': JSON.stringify(mcpJson, null, 2) }, true);

  await w.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Customize' }).click();
  await w.getByRole('tab', { name: 'Integrations' }).click();
  await w.getByRole('button', { name: 'Import servers from other tools' }).click();
  const dialog = w.getByRole('dialog', { name: 'Import MCP servers' });
  const found = dialog.getByRole('list', { name: 'Servers found' });
  await expect(found.getByRole('checkbox', { name: 'fixture' })).toBeVisible();
  await expect(found.getByText('Found in .mcp.json')).toBeVisible();
  await expect(found.getByText('Project (this computer)')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Add servers' })).toBeDisabled();
  await found.getByRole('checkbox', { name: 'fixture' }).check();
  await shot(w, 'setup-mcp-import');
  await dialog.getByRole('button', { name: 'Add 1 server' }).click();
  await expect(dialog).toBeHidden();

  // Added as the project's server on this computer, and connected: the project is trusted.
  const servers = w.getByRole('list', { name: 'MCP servers' });
  await expect(servers.getByText('fixture', { exact: true })).toBeVisible();
  await expect(servers.getByText('Connected · 2 tools')).toBeVisible();
  // The value that looks like a token went to the key store; the settings file only refers to it.
  const saved = fs.readFileSync(path.join(project, '.graft', 'settings.local.json'), 'utf8');
  expect(saved).toContain('"FIXTURE_API_TOKEN": "graft-secret:');
  expect(saved).not.toContain('kept-out-of-settings-123');
  // The other tool's file is left as it was.
  expect(JSON.parse(fs.readFileSync(path.join(project, '.mcp.json'), 'utf8'))).toEqual(mcpJson);

  // Opened again, the list says Graft has it now.
  await w.getByRole('button', { name: 'Import servers from other tools' }).click();
  await expect(dialog.getByText('Already in Graft')).toBeVisible();
  await expect(dialog.getByRole('checkbox', { name: 'fixture' })).toBeDisabled();
});

test('@ offers a folder row, and choosing it attaches the folder’s listing', async () => {
  const { w, model } = await start({ 'notes.txt': 'hello\n', 'src/lib/alpha.ts': 'export const a = 1;\n', 'src/lib/beta.ts': 'export const b = 2;\n' }, false);
  const box = await open(w, model);

  await box.fill('look at @');
  const menu = w.getByRole('listbox', { name: 'Mentions' });
  // The words come first, each with what it attaches.
  await expect(menu.getByRole('option', { name: /@diff.*Uncommitted changes/ })).toBeVisible();
  await expect(menu.getByRole('option', { name: /@terminal/ })).toBeVisible();
  await box.pressSequentially('lib');
  await expect(menu.getByRole('option', { name: 'src/lib/', exact: true })).toBeVisible();
  await shot(w, 'mentions-folder-row');
  await box.press('Enter');
  await expect(box).toHaveValue('look at @src/lib/ ');

  model.script({ text: 'Two files.' });
  await box.pressSequentially('and say what is in it');
  await box.press('Enter');
  await expect(w.getByText('Two files.', { exact: true })).toBeVisible();
  expect(requestText(model.chatRequests().at(-1)?.body)).toContain('<directory path="src/lib">\nalpha.ts\nbeta.ts\n</directory>');
});
