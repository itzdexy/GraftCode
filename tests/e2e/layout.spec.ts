import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchGraft, type LaunchedApp } from './support/launch';
import { MockProvider } from './support/mockProvider';
import { completeOnboarding, makeGitProject } from './support/onboard';

const SHOTS = path.join(__dirname, '..', '..', 'test-results', 'shots', 'layout');
const SIZES = [
  { width: 900, height: 600 },
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 }
];

let provider: MockProvider;
let graft: LaunchedApp;

test.afterEach(async () => {
  await graft.close();
  await provider.close();
});

async function resize(size: { width: number; height: number }): Promise<void> {
  await graft.app.evaluate(({ BrowserWindow }, s) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.unmaximize();
    win?.setContentSize(s.width, s.height);
  }, size);
  await expect.poll(() => graft.window.evaluate(() => [window.innerWidth, window.innerHeight])).toEqual([size.width, size.height]);
}

/** Elements wider than their scroll container would cut content off or scroll the page sideways. */
async function horizontalOverflow(w: Page): Promise<string[]> {
  return w.evaluate(() => {
    const problems: string[] = [];
    if (document.documentElement.scrollWidth > window.innerWidth + 1) problems.push(`page ${document.documentElement.scrollWidth} > ${window.innerWidth}`);
    // The sidebar is fixed-width with truncating rows; its resize handle intentionally straddles the edge.
    for (const el of Array.from(document.querySelectorAll('main, [role="region"], nav[aria-label="Settings"]'))) {
      const h = el as HTMLElement;
      const style = getComputedStyle(h);
      if (style.overflowX === 'visible' && h.scrollWidth > h.clientWidth + 1) problems.push(`${h.tagName.toLowerCase()}[${h.getAttribute('aria-label') ?? ''}] ${h.scrollWidth} > ${h.clientWidth}`);
    }
    return problems;
  });
}

/** Interactive elements a screen reader would announce without a name. */
async function unnamedControls(w: Page): Promise<string[]> {
  return w.evaluate(() => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll('button, a[href], input, select, textarea, [role="button"], [role="switch"], [role="tab"], [role="menuitem"], [role="option"], [role="radio"]'))) {
      const h = el as HTMLElement;
      if (h.closest('[aria-hidden="true"]') || h.getAttribute('tabindex') === '-1' || h.offsetParent === null) continue;
      const labelledBy = h.getAttribute('aria-labelledby');
      const byLabel = labelledBy ? labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ') : '';
      const id = h.id;
      const forLabel = id ? (document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent ?? '') : '';
      const wrapped = h.closest('label')?.textContent ?? '';
      const name = (h.getAttribute('aria-label') ?? '') || byLabel || forLabel || wrapped || (h.textContent ?? '').trim() || h.title || (h as HTMLInputElement).placeholder || '';
      if (name.trim().length === 0) out.push(h.outerHTML.slice(0, 120));
    }
    return out;
  });
}

test('main views fit from the minimum window size up to 1920×1080', async () => {
  provider = await MockProvider.start();
  const project = makeGitProject({ 'notes.txt': 'hello\n', 'src/app.ts': 'export const x = 1;\n' });
  graft = await launchGraft();
  const w = graft.window;
  await completeOnboarding(graft, provider, { project });
  provider.script({ text: 'A reply long enough to wrap across the transcript width when the window is narrow, so wrapping is exercised too.' });
  const composer = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await composer.fill('Hello');
  await composer.press('Enter');
  await expect(w.getByText(/A reply long enough/)).toBeVisible();
  const sessionUrl = await w.evaluate(() => location.href);
  fs.mkdirSync(SHOTS, { recursive: true });

  for (const size of SIZES) {
    await resize(size);
    const tag = `${size.width}x${size.height}`;

    // Session with the terminal panel open (the widest layout).
    await w.getByRole('button', { name: 'Terminal', exact: true }).click();
    await expect(w.getByRole('region', { name: 'Terminal' })).toBeVisible();
    expect(await horizontalOverflow(w), `session ${tag}`).toEqual([]);
    expect(await unnamedControls(w), `session controls ${tag}`).toEqual([]);
    await expect(w.getByRole('textbox', { name: /Type \/ for commands|Reply/ })).toBeVisible();
    await w.screenshot({ path: path.join(SHOTS, `session-${tag}.png`) });
    await w.getByRole('button', { name: 'Terminal', exact: true }).click();

    for (const [section, nav] of [
      ['Providers', 'settings-providers'],
      ['Permissions', 'settings-permissions']
    ] as const) {
      await w.getByRole('button', { name: /^Account menu for/ }).click();
      await w.getByRole('menuitem', { name: 'Settings' }).click();
      await w.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name: section, exact: true }).click();
      await expect(w.getByRole('heading', { level: 2, name: section })).toBeVisible();
      expect(await horizontalOverflow(w), `${nav} ${tag}`).toEqual([]);
      expect(await unnamedControls(w), `${nav} controls ${tag}`).toEqual([]);
      await w.screenshot({ path: path.join(SHOTS, `${nav}-${tag}.png`) });
    }

    await w.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Customize' }).click();
    await expect(w.getByRole('heading', { level: 1, name: 'Customize' })).toBeVisible();
    expect(await horizontalOverflow(w), `customize ${tag}`).toEqual([]);
    expect(await unnamedControls(w), `customize controls ${tag}`).toEqual([]);

    await w.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'New', exact: true }).click();
    await expect(w.getByRole('textbox', { name: 'Describe a task or ask a question' })).toBeVisible();
    expect(await horizontalOverflow(w), `home ${tag}`).toEqual([]);
    expect(await unnamedControls(w), `home controls ${tag}`).toEqual([]);
    await w.screenshot({ path: path.join(SHOTS, `home-${tag}.png`) });

    // Back to the session for the next size.
    await w.evaluate((url) => {
      if (location.href !== url) history.back();
    }, sessionUrl);
    await w.getByRole('navigation', { name: 'Main' }).getByText('Scripted title', { exact: true }).click();
    await expect(w.getByText(/A reply long enough/)).toBeVisible();
  }
});
