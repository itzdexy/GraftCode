import { expect, test } from '@playwright/test';
import { launchGraft } from './support/launch';
import { completeOnboarding, makeGitProject } from './support/onboard';
import { MockProvider } from './support/mockProvider';

test('leaked provider tokens receive honest guidance while Unicode and copy retain the original response', async () => {
  const provider = await MockProvider.start();
  const graft = await launchGraft();
  try {
    const w = graft.window;
    await completeOnboarding(graft, provider, { project: makeGitProject() });
    const original = 'Endpoint response 你好 <|close|> raw channel <|open|> original answer.';
    provider.script({ text: original });
    const composer = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
    await composer.fill('Hello'); await composer.press('Enter');
    const warning = w.getByRole('complementary', { name: 'Response quality warning' });
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('incompatible chat template');
    await expect(w.getByRole('log', { name: 'Conversation' })).toContainText(original);
    await warning.getByRole('button', { name: 'Copy original response', exact: true }).click();
    await expect(warning.getByRole('button', { name: 'Copied response', exact: true })).toBeVisible();
    // Compare in the app so a failure cannot expose unrelated host clipboard text.
    await expect.poll(() => graft.app.evaluate(async ({ clipboard }, expected) => await clipboard.readText() === expected, original)).toBe(true);
    await w.screenshot({ path: test.info().outputPath('response-guidance.png') });
    // Ordinary foreign-language text is never treated as broken model output.
    provider.script({ text: '你好，世界. A normal multilingual answer.' });
    const sessionComposer = w.getByRole('textbox', { name: /^Ask anything/ });
    await sessionComposer.fill('Try another answer'); await sessionComposer.press('Enter');
    await expect(w.getByRole('log', { name: 'Conversation' })).toContainText('A normal multilingual answer.');
    await expect(warning).toHaveCount(1);
  } finally { await graft.close(); await provider.close(); }
});
