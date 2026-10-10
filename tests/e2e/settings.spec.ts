import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchGraft, makeTempDir, type LaunchedApp } from './support/launch';
import { MockProvider } from './support/mockProvider';
import { completeOnboarding, makeGitProject } from './support/onboard';

const SHOTS = path.join(__dirname, '..', '..', 'test-results', 'shots');
async function shot(w: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true });
  await w.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

let provider: MockProvider;
let graft: LaunchedApp;

test.afterEach(async () => {
  await graft.close();
  await provider.close();
});

async function openSettings(w: Page, section: string): Promise<void> {
  const nav = w.getByRole('navigation', { name: 'Settings' });
  if (!(await nav.isVisible())) {
    await w.getByRole('button', { name: /^Account menu for/ }).click();
    await w.getByRole('menuitem', { name: 'Settings' }).click();
  }
  await nav.getByRole('button', { name: section, exact: true }).click();
  await expect(w.getByRole('heading', { level: 2, name: section })).toBeVisible();
}

test('web search is free by default; picking an engine updates what Graft searches with', async () => {
  provider = await MockProvider.start();
  graft = await launchGraft();
  const w = graft.window;
  await completeOnboarding(graft, provider);
  await openSettings(w, 'Web search');

  const engines = w.getByRole('radiogroup', { name: 'Search engine' });
  await expect(engines.getByRole('radio', { name: /^Automatic/ })).toBeChecked();
  await expect(w.getByText('Searching for free with Exa; DuckDuckGo steps in when Exa is busy.')).toBeVisible();
  await shot(w, 'settings-web-search');

  await engines.getByRole('radio', { name: /^DuckDuckGo/ }).check();
  await expect(w.getByText('Searching for free with DuckDuckGo; Exa steps in when it is busy.')).toBeVisible();

  // An engine that needs a key says so until one is saved.
  await engines.getByRole('radio', { name: /^Brave Search/ }).check();
  await expect(w.getByText('Brave Search isn’t set up yet.')).toBeVisible();
  await expect(w.getByRole('textbox', { name: 'Brave Search API key' })).toBeVisible();
  await expect(w.getByRole('button', { name: 'Test search' })).toBeDisabled();

  await engines.getByRole('radio', { name: /^Off/ }).check();
  await expect(w.getByText('Search is off.')).toBeVisible();
});

test('settings: appearance, rebinding a shortcut, a second provider and permission rules', async () => {
  provider = await MockProvider.start();
  graft = await launchGraft();
  const w = graft.window;
  await completeOnboarding(graft, provider);

  // /config in the composer opens Settings.
  const composer = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await composer.fill('/config');
  await composer.press('Escape');
  await composer.press('Enter');
  await expect(w.getByRole('heading', { level: 2, name: 'Profile' })).toBeVisible();
  await shot(w, 'settings-profile');

  // Appearance applies immediately.
  await openSettings(w, 'Appearance');
  await w.getByRole('radio', { name: 'Dark' }).click();
  await expect(w.locator('html')).toHaveAttribute('data-theme', 'dark');
  await w.getByRole('radio', { name: 'Light' }).click();
  await expect(w.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true');
  await expect(w.locator('html')).toHaveAttribute('data-theme', 'light');
  await shot(w, 'settings-appearance-light');
  await w.getByRole('radio', { name: 'Dark' }).click();
  await expect(w.locator('html')).toHaveAttribute('data-theme', 'dark');

  // Rebind search, reject a clash, then use the new binding.
  await openSettings(w, 'Shortcuts');
  await w.getByRole('button', { name: 'Change shortcut for Search chats and sessions' }).click();
  await w.keyboard.press('Control+N');
  await expect(w.getByText(/Already used for “New session or chat”/)).toBeVisible();
  await w.keyboard.press('Control+Shift+O');
  const row = w.getByRole('list', { name: 'Shortcuts' }).getByRole('listitem').filter({ hasText: 'Search chats and sessions' });
  await expect(row.getByText('Ctrl+Shift+O')).toBeVisible();
  await expect(row.getByRole('button', { name: 'Reset' })).toBeEnabled();
  await shot(w, 'settings-shortcuts');
  await w.locator('body').click({ position: { x: 600, y: 700 } });
  await w.keyboard.press('Control+Shift+O');
  await expect(w.getByRole('dialog', { name: /Search/ })).toBeVisible();
  await w.keyboard.press('Escape');

  // A second provider, verified before it is saved, then tested from its menu.
  await openSettings(w, 'Providers');
  await w.getByRole('button', { name: 'Add provider' }).click();
  const dialog = w.getByRole('dialog', { name: 'Add a provider' });
  // The picker searches the whole catalog (200+ providers) and fills in what it knows.
  const search = dialog.getByRole('combobox', { name: 'Search providers' });
  await expect(search).toHaveAttribute('placeholder', /Search (2\d\d|[3-9]\d\d) providers/);
  await search.fill('deepseek');
  await dialog.getByRole('option', { name: /^DeepSeek/ }).first().click();
  const deepseek = w.getByRole('dialog', { name: 'Add DeepSeek' });
  await expect(deepseek.getByLabel('Base URL')).toHaveValue('https://api.deepseek.com');
  await expect(deepseek.getByText(/Usually stored as DEEPSEEK_API_KEY/)).toBeVisible();
  await shot(w, 'settings-provider-preset');
  await deepseek.getByRole('button', { name: 'Back' }).click();
  await dialog.getByRole('combobox', { name: 'Search providers' }).fill('custom');
  await dialog.getByRole('option', { name: /Custom endpoint/ }).click();
  const form = w.getByRole('dialog', { name: 'Add Custom endpoint' });
  await form.getByLabel('Name').fill('Second endpoint');
  await form.getByLabel('Base URL').fill(provider.url);
  await expect(form.getByRole('button', { name: 'Add provider' })).toBeDisabled();
  await form.getByRole('button', { name: 'Verify' }).click();
  await expect(form.getByText(/Connected\. 2 models available\./)).toBeVisible();
  await form.getByRole('button', { name: 'Add provider' }).click();
  await expect(form).toBeHidden();
  const providers = w.getByRole('list', { name: 'Providers' });
  await expect(providers.getByRole('listitem')).toHaveCount(2);
  await providers.getByRole('button', { name: 'Options for Second endpoint' }).click();
  await w.getByRole('menuitem', { name: 'Test connection' }).click();
  await expect(w.getByText('Second endpoint is connected')).toBeVisible();
  await shot(w, 'settings-providers');

  // Both providers' models are offered as the default.
  await openSettings(w, 'Models');
  await expect(w.getByRole('listbox', { name: 'Default model' }).getByRole('option', { name: /Graft Test Large/ })).toHaveCount(2);
  await shot(w, 'settings-models');
  // A backup model for when a session's model keeps failing: chosen from the same list, and cleared with None.
  const backup = w.getByRole('listbox', { name: 'Backup model' });
  await expect(w.getByRole('button', { name: 'None', exact: true })).toBeDisabled();
  await backup.getByRole('option', { name: /Graft Test Mini/ }).first().click();
  const savedBackup = (): Promise<unknown> =>
    w.evaluate(async () => {
      const bridge = (window as unknown as { graft: { invoke(c: string, i: unknown): Promise<{ value: { defaults: { fallbackModel: unknown } } }> } }).graft;
      return (await bridge.invoke('settings:get', undefined)).value.defaults.fallbackModel;
    });
  await expect.poll(savedBackup).toMatchObject({ modelId: 'graft-test-mini' });
  await shot(w, 'settings-backup-model');
  await w.getByRole('button', { name: 'None', exact: true }).click();
  await expect.poll(savedBackup).toBeNull();
  // Agents: each kind of work can be given a model from either provider, or left to routing.
  const coder = w.getByRole('combobox', { name: 'Coder' });
  await expect(coder.getByRole('option', { name: /Graft Test Large/ })).toHaveCount(2);
  await expect(coder.getByRole('option').first()).toHaveText('The session’s model');
  await w.getByRole('radiogroup', { name: 'Models for agents' }).getByRole('radio', { name: 'Automatic' }).click();
  await expect(coder.getByRole('option').first()).toHaveText('Automatic');
  await shot(w, 'settings-agents');
  // Updates are on by default; a development build explains where they come from.
  await openSettings(w, 'About');
  await expect(w.getByText('Updates are delivered to installed builds.')).toBeVisible();
  await w.getByRole('switch', { name: 'Check for updates automatically' }).click();
  await expect(w.getByText('Automatic updates are off.')).toBeVisible();
  await shot(w, 'settings-about');

  // Permission rules: invalid rules are refused, valid ones land in ~/.graft/settings.json.
  await openSettings(w, 'Permissions');
  await w.getByLabel('New deny rule').first().fill('not a rule!');
  await w.getByLabel('New deny rule').first().press('Enter');
  await w.getByRole('button', { name: 'Save rules' }).click();
  await expect(w.getByText(/"not a rule!" is not a valid rule/)).toBeVisible();
  await w.getByRole('button', { name: 'Remove not a rule!' }).click();
  await w.getByLabel('New allow rule').first().fill('Shell(npm test:*)');
  await w.getByLabel('New allow rule').first().press('Enter');
  await w.getByRole('button', { name: 'Save rules' }).click();
  await expect(w.getByText('Rules saved')).toBeVisible();
  const saved = JSON.parse(fs.readFileSync(path.join(graft.graftHome, 'settings.json'), 'utf8')) as { permissions: { allow: string[]; deny: string[] } };
  expect(saved.permissions.allow).toEqual(['Shell(npm test:*)']);
  expect(saved.permissions.deny).toEqual([]);
  await shot(w, 'settings-permissions');

  // Bypass stays hidden until confirmed.
  await w.getByRole('switch', { name: 'Allow Bypass mode' }).click();
  await expect(w.getByRole('dialog', { name: 'Allow Bypass mode?' })).toBeVisible();
  await w.getByRole('button', { name: 'Cancel' }).click();
  await expect(w.getByRole('switch', { name: 'Allow Bypass mode' })).toHaveAttribute('aria-checked', 'false');
  await expect(w.getByRole('radio', { name: 'Bypass' })).toHaveCount(0);
});

test('data: export and clear history; with the tray on, closing the window keeps Graft running', async () => {
  provider = await MockProvider.start();
  const project = makeGitProject();
  graft = await launchGraft();
  const w = graft.window;
  await completeOnboarding(graft, provider, { project });

  provider.script({ text: 'All done here.' });
  const composer = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await composer.fill('Say something');
  await composer.press('Enter');
  await expect(w.getByText('All done here.')).toBeVisible();

  await openSettings(w, 'Data');
  const exportFile = path.join(makeTempDir('graft-e2e-export-'), 'graft-export.json');
  await graft.app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: file });
  }, exportFile);
  await w.getByRole('button', { name: 'Export…' }).click();
  await expect(w.getByText('Exported 1 session')).toBeVisible();
  const exported = JSON.parse(fs.readFileSync(exportFile, 'utf8')) as { format: string; sessions: Array<{ messages: Array<{ role: string }> }>; providers: unknown[] };
  expect(exported.format).toBe('graft-export');
  expect(exported.sessions).toHaveLength(1);
  expect(exported.sessions[0]?.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  expect(JSON.stringify(exported)).not.toMatch(/apiKey/i);
  await shot(w, 'settings-data');

  await w.getByRole('button', { name: 'Clear history…' }).click();
  await w.getByRole('button', { name: 'Delete all sessions' }).click();
  await expect(w.getByText('Deleted 1 session')).toBeVisible();
  await expect(w.getByText('No sessions here yet.')).toBeVisible();

  await openSettings(w, 'Notifications');
  // The sound is on until it is switched off; a finished session is quiet either way.
  const sound = w.getByRole('switch', { name: 'Play a sound' });
  await expect(sound).toHaveAttribute('aria-checked', 'true');
  await sound.click();
  await expect(sound).toHaveAttribute('aria-checked', 'false');
  await w.getByRole('switch', { name: 'Keep running in the tray' }).click();
  await expect(w.getByRole('switch', { name: 'Keep running in the tray' })).toHaveAttribute('aria-checked', 'true');
  await graft.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.close();
  });
  await expect
    .poll(() => graft.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((win) => win.isVisible())))
    .toEqual([false]);
  await graft.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.show();
  });
  await expect(w.getByRole('heading', { level: 2, name: 'Notifications' })).toBeVisible();
});

test('Settings → Usage counts a request on the day it was made, and a chat lists its commands', async () => {
  provider = await MockProvider.start();
  graft = await launchGraft();
  const w = graft.window;
  await completeOnboarding(graft, provider);

  await openSettings(w, 'Usage');
  await expect(w.getByText('Nothing used in the last 30 days')).toBeVisible();

  // One reply in a chat: one request, with the tokens the provider reported.
  await w.getByRole('radio', { name: 'Chat' }).click();
  await w.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'New', exact: true }).click();
  provider.script({ text: 'Counted.' });
  const home = w.getByRole('textbox', { name: 'How can I help you today?' });
  await home.fill('Say something short');
  await home.press('Enter');
  await expect(w.getByText('Counted.')).toBeVisible();

  // The chat's message box offers the commands a chat can use, and none that work on a project.
  // While its menu is open the message box is a combobox.
  const chatBox = 'Write a message, or type / for commands';
  const composer = w.getByRole('combobox', { name: chatBox }).or(w.getByRole('textbox', { name: chatBox }));
  await composer.fill('/');
  const offered = w.getByRole('listbox');
  await expect(offered.getByRole('option', { name: /^\/research/ })).toBeVisible();
  await expect(offered.getByRole('option', { name: /^\/context/ })).toBeVisible();
  await expect(offered.getByRole('option', { name: /^\/(plan|commit|init|mission)/ })).toHaveCount(0);
  // Typed anyway, one of those says where it works instead of asking the model.
  await composer.fill('/commit');
  await composer.press('Escape');
  await composer.press('Enter');
  await expect(w.getByText('/commit works on a project, so it runs in code sessions. Here, just ask.')).toBeVisible();
  // It never went to the provider: the one request is still the chat's first message.
  expect(provider.chatRequests()).toHaveLength(1);
  expect(JSON.stringify(provider.chatRequests()[0]!.body)).not.toContain('/commit');

  await openSettings(w, 'Usage');
  const totals = w.getByLabel('Totals');
  await expect(totals).toContainText('Requests1');
  await expect(totals).toContainText('Sent to models120');
  await expect(totals).toContainText('Written by models30');
  // The mock model has no published price: its request is counted and its cost is not made up.
  await expect(totals).toContainText('SpentUnknown');
  await expect(w.getByText('Nothing used in these days has a published price.')).toBeVisible();

  await w.getByRole('radiogroup', { name: 'What the bars measure' }).getByRole('radio', { name: 'Tokens' }).click();
  await expect(w.getByText(/^Most on .+: 150 tokens$/)).toBeVisible();
  // The chart is one stop for the keyboard: End reads today out.
  await w.getByRole('group', { name: /^Tokens for each of the last 30 days/ }).press('End');
  await expect(w.getByText(/: No published price · 120 sent · 30 written · 1 request$/)).toBeVisible();

  const byModel = w.getByRole('table', { name: 'What each model used in these days' });
  const row = byModel.getByRole('row', { name: /Graft Test Large/ });
  await expect(row.getByRole('cell')).toHaveText(['1', '120', '30', 'No published price']);

  await w.getByRole('button', { name: 'Show the days as a table' }).click();
  await expect(w.getByRole('table', { name: 'What was used on each day, newest first' }).getByRole('row')).toHaveCount(2);
  await shot(w, 'settings-usage');

  // It is stored, not held in memory: the same after Graft restarts.
  const { userData, graftHome } = graft;
  await graft.close();
  graft = await launchGraft({ userData, graftHome });
  await openSettings(graft.window, 'Usage');
  await expect(graft.window.getByLabel('Totals')).toContainText('Requests1');
});
