import { expect, test, type Page } from '@playwright/test';
import { launchGraft, type LaunchedApp } from './support/launch';
import { MockProvider } from './support/mockProvider';
import { completeOnboarding, makeGitProject } from './support/onboard';

/**
 * A walk through the whole app: every page of Settings, every tab of Customize,
 * every view, both modes, the palettes, and a session's panels and menus. It
 * fails on any error a page throws or logs, and on any part that shows
 * "… failed to display" instead of itself.
 */

const SETTINGS_PAGES = [
  'Profile',
  'Personalization',
  'Privacy',
  'Providers',
  'Models',
  'Web search',
  'Images',
  'Voice',
  'Permissions',
  'Sandbox',
  'Integrations',
  'Hooks',
  'Memory',
  'Appearance',
  'Shortcuts',
  'Notifications',
  'Usage',
  'Data',
  'About'
];
const CUSTOMIZE_TABS = ['Commands', 'Agents', 'Skills', 'Integrations', 'Checks', 'Hooks', 'Memory'];
const SESSION_BOX = /^(Ask anything|Queue a message)/;
const GREET = 'export function greet(name: string): string {\n  return `hello ${name}`;\n}\n';

let provider: MockProvider;
let graft: LaunchedApp;
let errors: string[];

test.beforeEach(async () => {
  provider = await MockProvider.start();
  graft = await launchGraft();
  errors = [];
  graft.window.on('pageerror', (error) => errors.push(`Uncaught: ${error.message}`));
  graft.window.on('console', (message) => {
    if (message.type() === 'error') errors.push(`Logged: ${message.text()}`);
  });
  await completeOnboarding(graft, provider, { project: makeGitProject({ 'notes.txt': 'hello\n', 'src/greet.ts': GREET }) });
});

test.afterEach(async () => {
  await graft.close();
  await provider.close();
});

/** Whether a chat request ends with these words from the user (messages sent one after another arrive as one). */
function lastUserSays(body: unknown, words: string): boolean {
  const messages = (body as { messages?: Array<{ role: string; content: unknown }> }).messages ?? [];
  const content = messages.findLast((m) => m.role === 'user')?.content;
  const parts = Array.isArray(content) ? (content as Array<{ type?: string; text?: string }>) : [];
  const text = typeof content === 'string' ? content : (parts.filter((p) => p.type === 'text').at(-1)?.text ?? '');
  return text.trim().endsWith(words);
}

/** Nothing on screen gave up: a part that failed shows "… failed to display" in its place. */
async function nothingBroken(w: Page): Promise<void> {
  await expect(w.getByText(/failed to display$/)).toHaveCount(0);
}

test('every page of Settings, every tab of Customize and every view opens, in both modes, and the palettes find things', async () => {
  const w = graft.window;

  await w.getByRole('button', { name: /^Account menu for/ }).click();
  await w.getByRole('menuitem', { name: 'Settings' }).click();
  const settings = w.getByRole('dialog', { name: 'Settings' });
  const pages = settings.getByRole('navigation', { name: 'Settings' });
  for (const page of SETTINGS_PAGES) {
    await pages.getByRole('button', { name: page, exact: true }).click();
    // The page's own title, not a group on it with the same name.
    await expect(settings.getByRole('banner').getByRole('heading', { level: 2, name: page, exact: true })).toBeVisible();
    await nothingBroken(w);
  }

  // A long page scrolls, and its scrollbar lights up while it does and fades after.
  await pages.getByRole('button', { name: 'Shortcuts', exact: true }).click();
  const heading = await settings.getByRole('banner').getByRole('heading', { level: 2, name: 'Shortcuts', exact: true }).boundingBox();
  await w.mouse.move((heading?.x ?? 400) + 40, (heading?.y ?? 100) + 200);
  await w.mouse.wheel(0, 600);
  await expect.poll(() => w.evaluate(() => document.querySelectorAll('.graft-scrolling').length)).toBeGreaterThan(0);
  await expect.poll(() => w.evaluate(() => document.querySelectorAll('.graft-scrolling').length)).toBe(0);

  // Searching finds a setting on its page, and says when nothing matches.
  const search = settings.getByRole('searchbox', { name: 'Search settings' });
  await search.fill('theme');
  await settings.getByRole('list', { name: 'Settings found' }).getByRole('button', { name: /^Theme/ }).first().click();
  await expect(settings.getByRole('banner').getByRole('heading', { level: 2, name: 'Appearance', exact: true })).toBeVisible();
  await search.fill('nothing at all like this');
  await expect(settings.getByText('No setting matches.')).toBeVisible();
  await search.fill('');
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(settings).toHaveCount(0);

  // The views of Code mode, the folded ones under More too.
  const main = w.getByRole('navigation', { name: 'Main' });
  const more = main.getByRole('button', { name: 'More', exact: true });
  if ((await more.count()) > 0 && (await more.getAttribute('aria-expanded')) !== 'true') await more.click();
  for (const view of ['Sites', 'Artifacts', 'Projects', 'Scheduled', 'Customize']) {
    await main.getByRole('button', { name: view, exact: true }).click();
    await expect(w.getByRole('heading', { level: 1, name: view, exact: true })).toBeVisible();
    await nothingBroken(w);
  }
  const tabs = w.getByRole('tablist', { name: 'Customize' });
  for (const tab of CUSTOMIZE_TABS) {
    await tabs.getByRole('tab', { name: tab, exact: true }).click();
    await expect(tabs.getByRole('tab', { name: tab, exact: true })).toHaveAttribute('aria-selected', 'true');
    await nothingBroken(w);
  }

  // The command palette lists commands for what is typed; search opens over any page.
  await w.keyboard.press('ControlOrMeta+Shift+P');
  const command = w.getByRole('combobox', { name: 'Command' });
  await command.fill('theme');
  await expect(w.getByRole('listbox', { name: 'Commands' }).getByRole('option').first()).toBeVisible();
  await command.press('Escape');
  await expect(command).toBeHidden();
  await w.keyboard.press('ControlOrMeta+K');
  const find = w.getByRole('combobox', { name: 'Search' });
  await find.fill('hello');
  await nothingBroken(w);
  await find.press('Escape');
  await expect(find).toBeHidden();

  // Chat mode: its home, a reply, and its views.
  provider.script({ text: 'Hello there.' });
  await w.getByRole('radio', { name: 'Chat' }).click();
  const chat = w.getByRole('textbox', { name: 'How can I help you today?' });
  await chat.fill('Hi');
  await chat.press('Enter');
  await expect(w.getByText('Hello there.')).toBeVisible();
  for (const view of ['Projects', 'Sites', 'Artifacts', 'Scheduled']) {
    await main.getByRole('button', { name: view, exact: true }).click();
    await expect(w.getByRole('heading', { level: 1, name: view, exact: true })).toBeVisible();
    await nothingBroken(w);
  }
  await w.getByRole('radio', { name: 'Code' }).click();
  await expect(w.getByRole('textbox', { name: 'Describe a task or ask a question' })).toBeVisible();

  expect(errors).toEqual([]);
});

test('a session writes code, shows it in every panel, opens every menu, and stops and is deleted while it runs', async () => {
  const w = graft.window;
  provider.script({ toolCalls: [{ name: 'Write', input: { file_path: 'src/app.ts', content: 'export const answer = 42;\n' } }] }, { text: 'Wrote src/app.ts.' });
  const composer = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await composer.fill('Write the app');
  await composer.press('Enter');
  const conversation = w.getByRole('log', { name: 'Conversation' });
  // What was sent shows before anything else happens.
  await expect(conversation.getByText('Write the app', { exact: true }).first()).toBeVisible();
  await w.getByRole('alertdialog').getByRole('button', { name: /Allow once/ }).click();
  await expect(conversation.getByText('Wrote src/app.ts.')).toBeVisible();

  // The terminal.
  await w.getByRole('button', { name: 'Terminal', exact: true }).click();
  const terminal = w.getByRole('region', { name: 'Terminal' });
  await expect(terminal.getByRole('tab', { name: /1 ·/ })).toBeVisible();
  await w.getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(terminal).toBeHidden();

  // Changes, files, search and problems.
  await w.getByRole('button', { name: 'Changes and files' }).click();
  const changes = w.getByRole('region', { name: 'Changes' });
  await expect(changes.getByRole('button', { name: /app\.ts \(/ })).toBeVisible();
  await changes.getByRole('tab', { name: 'Files' }).click();
  await expect(changes.getByRole('tree', { name: 'Files' })).toBeVisible();
  await changes.getByRole('tab', { name: 'Search' }).click();
  await changes.locator('input[aria-label="Search in files"]').fill('greet');
  await expect(changes.getByLabel(/greet\.ts line 1:/)).toBeVisible();
  await changes.getByRole('tab', { name: /^Problems/ }).click();
  await nothingBroken(w);
  await w.getByRole('button', { name: 'Changes and files' }).click();
  await expect(changes).toBeHidden();

  // The browser and the agents.
  for (const panel of ['Browser', 'Agents']) {
    await w.getByRole('button', { name: panel, exact: true }).click();
    await expect(w.getByRole('region', { name: panel })).toBeVisible();
    await nothingBroken(w);
    await w.getByRole('button', { name: panel, exact: true }).click();
    await expect(w.getByRole('region', { name: panel })).toBeHidden();
  }

  // The details column folds away and comes back.
  const details = w.getByRole('complementary', { name: 'Session details' });
  await expect(details).toBeVisible();
  await w.getByRole('button', { name: 'Session details' }).click();
  await expect(details).toBeHidden();
  await w.getByRole('button', { name: 'Session details' }).click();
  await expect(details).toBeVisible();
  // A right-click on it chooses its cards: one taken out, then put back.
  const environment = details.getByRole('group', { name: 'Environment' });
  await expect(environment).toBeVisible();
  for (const shown of [false, true]) {
    await details.click({ button: 'right', position: { x: 60, y: 14 } });
    const item = w.getByRole('menuitemcheckbox', { name: 'Environment' });
    await expect(item).toHaveAttribute('aria-checked', String(!shown));
    await item.click();
    await w.keyboard.press('Escape');
    await expect(environment).toHaveCount(shown ? 1 : 0);
  }

  // Each menu of the composer opens and closes.
  for (const name of [/^Permission mode:/, /^Model:/, /^Effort:/, /^Transcript view:/]) {
    const opener = w.getByRole('button', { name });
    // A model without effort levels has no effort menu.
    if ((await opener.count()) === 0 && String(name) === String(/^Effort:/)) continue;
    await opener.click();
    await expect(w.locator('[role="menu"], [role="dialog"]').first()).toBeVisible();
    await nothingBroken(w);
    await w.keyboard.press('Escape');
    await expect(w.locator('[role="menu"], [role="dialog"]')).toHaveCount(0);
  }

  // Find in the conversation, open a file by name, go to a symbol.
  await conversation.click({ position: { x: 20, y: 20 } });
  await w.keyboard.press('ControlOrMeta+F');
  const inConversation = w.getByRole('textbox', { name: 'Find in the conversation' });
  await inConversation.fill('app');
  await expect(w.getByRole('search', { name: 'Find in the conversation' })).toContainText(/\d/);
  await inConversation.press('Escape');
  await expect(inConversation).toBeHidden();
  await w.keyboard.press('ControlOrMeta+P');
  const openFile = w.getByRole('combobox', { name: 'Open a file' });
  await openFile.fill('greet');
  await expect(w.getByRole('option', { name: /greet\.ts/ })).toBeVisible();
  await openFile.press('Enter');
  await expect(w.getByRole('tablist', { name: 'Open files' }).getByRole('tab', { name: /greet\.ts/ })).toBeVisible();
  await w.keyboard.press('ControlOrMeta+T');
  const symbol = w.getByRole('combobox', { name: 'Go to a symbol' });
  await expect(symbol).toBeVisible();
  await symbol.press('Escape');
  await expect(symbol).toBeHidden();

  // Stop, pressed the moment a message is sent, ends the turn wherever it has got to and says so; the next
  // message is answered. (Whether the model was asked yet depends on how quickly Stop came, so it is held either way.)
  provider.respondToChat = (body) => (lastUserSays(body, 'Think it over') ? { text: 'Thinking about a long answer', chunkDelayMs: 40, hold: true } : { text: 'Second answer.' });
  const box = w.getByRole('textbox', { name: SESSION_BOX });
  await box.fill('Think it over');
  await box.press('Enter');
  await expect(conversation.getByText('Think it over', { exact: true }).first()).toBeVisible();
  await w.getByRole('button', { name: 'Stop' }).click();
  await expect(conversation.getByText('Stopped.')).toBeVisible();
  await expect(w.getByRole('button', { name: 'Stop' })).toBeHidden();
  await box.fill('Go on');
  await box.press('Enter');
  await expect(conversation.getByText('Second answer.')).toBeVisible();
  provider.respondToChat = null;

  // A session is deleted while it runs: its reply ends and it leaves the list.
  provider.script({ text: 'A very long job', chunkDelayMs: 40, hold: true });
  await box.fill('Start a long job');
  await box.press('Enter');
  await expect(conversation.getByText(/A very long/)).toBeVisible();
  const ended = provider.waitForHeldStreamClosed();
  const sidebar = w.getByRole('complementary', { name: 'Sidebar' });
  await sidebar.getByRole('button', { name: /^Options for / }).click();
  await w.getByRole('menuitem', { name: 'Delete…' }).click();
  await w.getByRole('button', { name: 'Delete', exact: true }).click();
  await ended;
  await expect(sidebar.getByRole('button', { name: /^Options for / })).toHaveCount(0);
  await nothingBroken(w);

  expect(errors).toEqual([]);
});
