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
  await w.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'New', exact: true }).click();
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

    // Explicit On remains animated even when the operating system reduces motion.
    await setMotion(w, 'On');
    const animated = await timings(w);
    expect(animated.length).toBeGreaterThan(1);
    expect(animated.every((item) => item.duration > 0 && item.duration + item.delay <= 0.35)).toBe(true);

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
