import { expect, test, type Page } from '@playwright/test';
import { launchGraft } from './support/launch';
import { completeOnboarding } from './support/onboard';
import { MockProvider } from './support/mockProvider';

async function setMotion(w: Page, mode: 'On' | 'Reduced' | 'System'): Promise<void> {
  await w.getByRole('button', { name: /^Account menu for/ }).click();
  await w.getByRole('menuitem', { name: /^Settings/ }).click();
  await w.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name: 'Appearance', exact: true }).click();
  const choice = w.getByRole('radiogroup', { name: 'Motion', exact: true }).getByRole('radio', { name: mode, exact: true });
  await choice.click();
  await expect(choice).toHaveAttribute('aria-checked', 'true');
  if (mode === 'System') await expect(w.locator('html')).not.toHaveAttribute('data-motion');
  else await expect(w.locator('html')).toHaveAttribute('data-motion', mode === 'On' ? 'full' : 'reduced');
  // Settings is a window over the page: it is closed before the page underneath is used.
  await w.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Close', exact: true }).click();
  await expect(w.locator('[role="dialog"][aria-label="Settings"]')).toHaveCount(0);
  await w.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'New', exact: true }).click();
  await expect(w.locator('.motion-stagger')).toBeVisible();
}

/** Sets Settings → Appearance → Motion style, and goes back to the home screen. */
async function setStyle(w: Page, style: 'Lively' | 'Calm'): Promise<void> {
  await w.getByRole('button', { name: /^Account menu for/ }).click();
  await w.getByRole('menuitem', { name: /^Settings/ }).click();
  await w.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name: 'Appearance', exact: true }).click();
  const choice = w.getByRole('radiogroup', { name: 'Motion style', exact: true }).getByRole('radio', { name: style, exact: true });
  await choice.click();
  await expect(choice).toHaveAttribute('aria-checked', 'true');
  await expect(w.locator('html')).toHaveAttribute('data-motion-style', style.toLowerCase());
  await w.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Close', exact: true }).click();
  await expect(w.locator('[role="dialog"][aria-label="Settings"]')).toHaveCount(0);
  await expect(w.locator('.motion-stagger')).toBeVisible();
}

async function timings(w: Page): Promise<Array<{ duration: number; delay: number }>> {
  return w.locator('.motion-stagger > *').evaluateAll((elements) => elements.map((element) => {
    const style = getComputedStyle(element);
    return { duration: parseFloat(style.animationDuration), delay: parseFloat(style.animationDelay) };
  }));
}

test('motion follows its preference and system changes without leaving delayed content in reduced mode', async () => {
  const provider = await MockProvider.start();
  const graft = await launchGraft();
  try {
    const w = graft.window;
    await completeOnboarding(graft, provider);
    await w.emulateMedia({ reducedMotion: 'reduce' });

    // Explicit On remains animated even when the operating system reduces motion. The style is Lively unless Calm is
    // chosen: the home screen springs into place piece by piece, and the last piece has settled within 550 ms.
    await setMotion(w, 'On');
    await expect(w.locator('html')).toHaveAttribute('data-motion-style', 'lively');
    const lively = await timings(w);
    expect(lively.length).toBeGreaterThan(1);
    expect(lively.every((item) => item.duration > 0 && item.duration + item.delay <= 0.55)).toBe(true);
    expect(Math.max(...lively.map((item) => item.duration))).toBeCloseTo(0.38, 2);

    // Calm is the short fade it was before there was a choice: everything is there within 350 ms.
    await setStyle(w, 'Calm');
    const calm = await timings(w);
    expect(calm.every((item) => item.duration > 0 && item.duration + item.delay <= 0.35)).toBe(true);

    // Reduced is still for both styles.
    await setStyle(w, 'Lively');
    await setMotion(w, 'Reduced');
    expect((await timings(w)).every((item) => item.duration === 0 && item.delay === 0)).toBe(true);

    // System observes live preference changes while the same home stays mounted.
    await setMotion(w, 'System');
    expect((await timings(w)).every((item) => item.duration === 0 && item.delay === 0)).toBe(true);
    await w.emulateMedia({ reducedMotion: 'no-preference' });
    expect((await timings(w)).every((item) => item.duration > 0)).toBe(true);
  } finally {
    await graft.close();
    await provider.close();
  }
});
