import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchGraft, type LaunchedApp } from './support/launch';
import { MockProvider } from './support/mockProvider';
import { completeOnboarding, makeGitProject } from './support/onboard';

const SHOTS = path.join(__dirname, '..', '..', 'test-results', 'shots');
/** The Settings window, found whether or not another dialog lies over it. */
const SETTINGS_WINDOW = '[role="dialog"][aria-label="Settings"]';

/** A picture of the window once what is arriving has arrived: a frame taken mid-entrance shows things half faded. */
async function shot(w: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true });
  await w.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))));
  await w.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

let provider: MockProvider;
let graft: LaunchedApp;

test.beforeEach(async () => {
  provider = await MockProvider.start();
  graft = await launchGraft();
  await completeOnboarding(graft, provider, { project: makeGitProject({ 'notes.txt': 'hello\n' }) });
});

test.afterEach(async () => {
  await graft.close();
  await provider.close();
});

async function openSettings(w: Page): Promise<void> {
  await w.getByRole('button', { name: /^Account menu for/ }).click();
  await w.getByRole('menuitem', { name: /^Settings/ }).click();
  await expect(w.getByRole('dialog', { name: 'Settings' })).toBeVisible();
}

/** Sets the Motion setting and closes Settings again. */
async function motion(w: Page, mode: 'On' | 'Reduced'): Promise<void> {
  await openSettings(w);
  const settings = w.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name: 'Appearance', exact: true }).click();
  await settings.getByRole('radiogroup', { name: 'Motion', exact: true }).getByRole('radio', { name: mode, exact: true }).click();
  await expect(w.locator('html')).toHaveAttribute('data-motion', mode === 'On' ? 'full' : 'reduced');
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(w.locator(SETTINGS_WINDOW)).toHaveCount(0);
}

/** Counts the view transitions the page starts from now on. */
const countTransitions = (w: Page): Promise<void> =>
  w.evaluate(() => {
    const page = window as unknown as { transitions: number };
    page.transitions = 0;
    const start = document.startViewTransition.bind(document);
    document.startViewTransition = ((callback?: () => void) => {
      page.transitions++;
      return start(callback);
    }) as typeof document.startViewTransition;
  });
const transitions = (w: Page): Promise<number> => w.evaluate(() => (window as unknown as { transitions: number }).transitions);
/** The time a whole view takes to give way to another, in milliseconds (the stylesheet may write it as ".15s"). */
const viewDuration = (w: Page): Promise<number> =>
  w.evaluate(() => {
    const time = getComputedStyle(document.documentElement).getPropertyValue('--g-duration-view').trim();
    return parseFloat(time) * (time.endsWith('ms') ? 1 : 1000);
  });

async function firstTurn(w: Page, reply: string): Promise<void> {
  provider.script({ text: reply });
  await w.getByRole('textbox', { name: 'Describe a task or ask a question' }).fill('hello');
  await w.keyboard.press('Enter');
  await expect(w.getByText(reply, { exact: true })).toBeVisible();
}

test('Settings opens over the session, fits the smallest window, and closes back to it', async () => {
  const w = graft.window;
  await firstTurn(w, 'Hi from the session.');

  await graft.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(900, 600));
  await expect.poll(() => w.evaluate(() => window.innerWidth)).toBe(900);
  await openSettings(w);
  const settings = w.getByRole('dialog', { name: 'Settings' });
  // The page underneath is still the session, and the window is the one thing with the keyboard: no button of it is picked out.
  await expect(w.getByText('Hi from the session.', { exact: true })).toBeAttached();
  await expect(settings).toBeFocused();
  await expect(w.getByRole('tooltip')).toHaveCount(0);
  await shot(w, 'settings-window-small');
  const box = (await settings.boundingBox())!;
  const page = await w.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  expect(box.width).toBeLessThanOrEqual(1000);
  expect(box.height).toBeLessThanOrEqual(720);
  expect(Math.min(box.x, box.y, page.width - box.x - box.width, page.height - box.y - box.height)).toBeGreaterThanOrEqual(32);
  // Its page scrolls inside it: the window itself never grows past its frame.
  await settings.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name: 'Permissions', exact: true }).click();
  await expect(settings.getByRole('heading', { level: 2, name: 'Permissions' })).toBeVisible();
  expect(((await settings.boundingBox())!).height).toBe(box.height);

  // Esc while a shortcut is being recorded belongs to the recorder.
  await settings.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name: 'Shortcuts', exact: true }).click();
  await settings.getByRole('button', { name: 'Change shortcut for Open settings' }).click();
  await expect(settings.getByRole('button', { name: 'Press the new shortcut for Open settings' })).toBeVisible();
  await w.keyboard.press('Escape');
  await expect(settings.getByRole('button', { name: 'Change shortcut for Open settings' })).toBeVisible();
  await expect(settings).toBeVisible();

  // With nothing being recorded, Esc closes the window, and the session underneath is back and takes clicks.
  await w.keyboard.press('Escape');
  await expect(w.locator(SETTINGS_WINDOW)).toHaveCount(0);
  await expect(w.getByText('Hi from the session.', { exact: true })).toBeVisible();
  await w.getByRole('textbox', { name: /^Ask anything/ }).click();
  await expect(w.getByRole('textbox', { name: /^Ask anything/ })).toBeFocused();

  // The history is as it was before Settings opened: Forward opens it where it was first opened, and Back steps out again.
  await w.getByRole('button', { name: 'Forward', exact: true }).click();
  await expect(settings.getByRole('heading', { level: 2, name: 'Profile' })).toBeVisible();
  // A click beside the window closes it.
  await w.mouse.click(8, 300);
  await expect(w.locator(SETTINGS_WINDOW)).toHaveCount(0);
  await expect(w.getByText('Hi from the session.', { exact: true })).toBeVisible();
});

test('views cross-fade with motion on and never with it reduced', async () => {
  const w = graft.window;
  await firstTurn(w, 'One.');
  await w.emulateMedia({ reducedMotion: 'reduce' });

  await motion(w, 'On');
  await countTransitions(w);
  await w.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'New', exact: true }).click();
  await expect(w.getByRole('textbox', { name: 'Describe a task or ask a question' })).toBeVisible();
  expect(await transitions(w)).toBeGreaterThanOrEqual(1);
  expect(await viewDuration(w)).toBe(150);
  // The page stays usable while it fades: a click is never lost to the fade.
  expect(await w.evaluate(() => getComputedStyle(document.documentElement, '::view-transition').pointerEvents)).toBe('none');
  // A new theme fades in the same way, once the fade before it is over.
  await w.waitForTimeout(400);
  await countTransitions(w);
  await openSettings(w);
  const settings = w.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name: 'Appearance', exact: true }).click();
  const before = await w.locator('html').getAttribute('data-theme');
  await settings.getByRole('radio', { name: before === 'dark' ? 'Light' : 'Dark', exact: true }).click();
  await expect(w.locator('html')).toHaveAttribute('data-theme', before === 'dark' ? 'light' : 'dark');
  expect(await transitions(w)).toBeGreaterThanOrEqual(1);
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(w.locator(SETTINGS_WINDOW)).toHaveCount(0);

  await motion(w, 'Reduced');
  await countTransitions(w);
  await w.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(w.getByText('One.', { exact: true })).toBeVisible();
  expect(await transitions(w)).toBe(0);
  expect(await viewDuration(w)).toBe(0);
});

/** Starts timing, inside the page, how long the panels stay after their column is told to close. */
const watchPanelsLeave = (w: Page): Promise<void> =>
  w.evaluate(() => {
    const column = document.querySelector('aside[aria-label="Panels"]')?.closest('.graft-slide-x');
    const page = window as unknown as { lingered: number | null; watching?: MutationObserver };
    // The column is the same element every time: an earlier watch would time this closing from its own.
    page.watching?.disconnect();
    page.lingered = null;
    if (!column) return;
    let closedAt = 0;
    page.watching = new MutationObserver(() => {
      if (closedAt === 0 && column.getAttribute('data-state') === 'closed') closedAt = performance.now();
      if (closedAt > 0 && page.lingered === null && !column.querySelector('aside')) page.lingered = performance.now() - closedAt;
    });
    page.watching.observe(column, { attributes: true, childList: true, subtree: true });
  });
const lingered = (w: Page): Promise<number | null> => w.evaluate(() => (window as unknown as { lingered: number | null }).lingered);

test('the panel column slides shut with its panels in it, and is gone at once with motion reduced', async () => {
  const w = graft.window;
  await firstTurn(w, 'Hi.');
  await w.emulateMedia({ reducedMotion: 'reduce' });
  const panels = w.getByRole('complementary', { name: 'Panels' });

  await motion(w, 'On');
  await w.keyboard.press('Control+Shift+D');
  await expect(panels).toBeVisible();
  // The panels keep a width of their own; only the column around them slides, over the time a slide takes.
  await expect(panels).toHaveAttribute('style', /width: \d+px/);
  const column = w.locator('.graft-slide-x').filter({ has: panels });
  await expect(column).toHaveAttribute('data-state', 'open');
  expect(await column.evaluate((el) => getComputedStyle(el).transitionProperty)).toContain('grid-template-columns');
  expect(await column.evaluate((el) => parseFloat(getComputedStyle(el).transitionDuration))).toBeGreaterThan(0);
  await watchPanelsLeave(w);
  await w.keyboard.press('Control+Shift+D');
  await expect.poll(() => lingered(w)).not.toBeNull();
  expect(await lingered(w)).toBeGreaterThanOrEqual(150); // they stayed while the column slid shut (180 ms)
  await expect(panels).toHaveCount(0);
  // The transcript has the room back, and the panel is there again when it is asked for.
  await w.keyboard.press('Control+Shift+D');
  await expect(panels.getByRole('region', { name: 'Changes', exact: true })).toBeVisible();
  await w.keyboard.press('Control+Shift+D');
  await expect(panels).toHaveCount(0);

  await motion(w, 'Reduced');
  await w.keyboard.press('Control+Shift+D');
  await expect(panels).toBeVisible();
  await watchPanelsLeave(w);
  await w.keyboard.press('Control+Shift+D');
  await expect.poll(() => lingered(w)).not.toBeNull();
  expect(await lingered(w)).toBeLessThan(50);
});

test('a task whose state changed is marked as its list arrives, and rows carry what lets them travel', async () => {
  const w = graft.window;
  const tasks = (first: 'pending' | 'completed') => ({ name: 'TodoWrite', input: { todos: [{ id: 'a', content: 'Read the code', status: first }, { id: 'b', content: 'Write the fix', status: 'pending' }] } });
  provider.script({ toolCalls: [tasks('pending')] }, { toolCalls: [tasks('completed')] }, { text: 'Done.' });
  await w.emulateMedia({ reducedMotion: 'no-preference' });
  await w.getByRole('textbox', { name: 'Describe a task or ask a question' }).fill('do it');
  await w.keyboard.press('Enter');
  await expect(w.getByText('Done.', { exact: true })).toBeVisible();

  const list = w.getByRole('list', { name: 'Task list' }).last();
  await expect(list.getByLabel('Done')).toHaveCount(1);
  const changed = list.locator('.todo-mark--changed');
  await expect(changed).toHaveCount(1); // the task that finished, and not the one that did not change
  await expect(changed).toHaveAttribute('aria-label', 'Done');
  expect(await changed.evaluate((el) => getComputedStyle(el).animationName)).toBe('graft-pop');
  await expect(w.getByRole('navigation', { name: 'Main' }).locator('[data-flip-key]').first()).toBeAttached();

  // A session that is opened later draws its lists still: the mark is there, and nothing animates it.
  const { userData, graftHome } = graft;
  await graft.close();
  graft = await launchGraft({ userData, graftHome });
  const again = graft.window;
  await again.getByRole('navigation', { name: 'Main' }).locator('[data-flip-key]').first().click();
  await expect(again.getByText('Done.', { exact: true })).toBeVisible();
  const later = again.getByRole('list', { name: 'Task list' }).last().locator('.todo-mark--changed');
  await expect(later).toHaveCount(1);
  expect(await later.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
});
