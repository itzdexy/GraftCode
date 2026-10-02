import { expect, test, type Page } from '@playwright/test';
import { launchGraft, makeTempDir } from './support/launch';
import { MockProvider } from './support/mockProvider';

const KEY = 'e2e-secret-key-123456';

async function nameAndPicture(w: Page, name: string): Promise<void> {
  await expect(w.getByRole('heading', { name: 'What should we call you?' })).toBeVisible();
  await w.getByLabel('Your name').fill(name);
  await w.keyboard.press('Enter');
  await expect(w.getByRole('heading', { name: 'Add a profile picture' })).toBeVisible();
  await w.getByRole('button', { name: 'Skip' }).click();
  await expect(w.getByRole('heading', { name: 'Choose a model provider' })).toBeVisible();
}

test('first run: name, picture, provider, verified key and defaults land on Code home', async () => {
  const provider = await MockProvider.start({ apiKey: KEY });
  const graft = await launchGraft();
  const w = graft.window;
  try {
    // Name is required and trimmed.
    await expect(w.getByRole('heading', { name: 'What should we call you?' })).toBeVisible();
    await w.getByRole('button', { name: 'Continue' }).click();
    await expect(w.getByText('Enter a name.')).toBeVisible();
    await w.getByLabel('Your name').fill('   ');
    await w.getByRole('button', { name: 'Continue' }).click();
    await expect(w.getByText('Enter a name.')).toBeVisible();
    await nameAndPicture(w, '  Robin  ');

    // Provider cards: keyboard selection works; continue needs a choice.
    await expect(w.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await w.getByRole('radio', { name: /Custom endpoint/ }).click();
    await expect(w.getByRole('radio', { name: /Custom endpoint/ })).toHaveAttribute('aria-checked', 'true');
    await w.getByRole('button', { name: 'Continue' }).click();

    // Key step: cannot continue until verified; a wrong key gives a specific error.
    await expect(w.getByRole('heading', { name: 'Connect your endpoint' })).toBeVisible();
    await w.getByLabel('Base URL').fill(provider.url);
    await w.getByLabel('API key (optional)').fill('wrong-key');
    await w.getByRole('button', { name: 'Verify' }).click();
    await expect(w.getByText('Custom endpoint rejected this key.')).toBeVisible();
    await expect(w.getByRole('button', { name: 'Continue' })).toBeDisabled();

    // A wrong base URL is reported as such.
    await w.getByLabel('Base URL').fill(provider.url.replace('/v1', '/nothing-here'));
    await w.getByLabel('API key (optional)').fill(KEY);
    await w.getByRole('button', { name: 'Verify' }).click();
    await expect(w.getByText('No compatible API answered at that address.')).toBeVisible();

    await w.getByLabel('Base URL').fill(provider.url);
    await w.getByRole('button', { name: 'Verify' }).click();
    await expect(w.getByText('Connected. 2 models available.')).toBeVisible();
    // Editing after verification requires verifying again.
    await w.getByLabel('API key (optional)').fill(`${KEY}x`);
    await expect(w.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await w.getByLabel('API key (optional)').fill(KEY);
    await w.getByRole('button', { name: 'Verify' }).click();
    await expect(w.getByText('Connected. 2 models available.')).toBeVisible();
    // Without an OS keyring (Linux containers), keys are stored only after an explicit opt-in.
    const plaintext = w.getByRole('checkbox', { name: 'Store keys unencrypted on this computer' });
    if ((await plaintext.count()) > 0) {
      await expect(w.getByRole('button', { name: 'Continue' })).toBeDisabled();
      await plaintext.check();
    }
    await w.getByRole('button', { name: 'Continue' }).click();

    // Defaults: models come from the provider's list-models call.
    await expect(w.getByRole('heading', { name: 'Pick your defaults' })).toBeVisible();
    await expect(w.getByRole('option', { name: /Graft Test Large/ })).toHaveAttribute('aria-selected', 'true');
    await w.getByRole('option', { name: /Graft Test Mini/ }).click();
    await expect(w.getByRole('option', { name: /Graft Test Mini/ })).toHaveAttribute('aria-selected', 'true');
    await w.getByRole('button', { name: 'Start using Graft' }).click();

    // Code home.
    await expect(w.getByRole('heading', { name: 'Welcome, Robin' })).toBeVisible();
    await expect(w.getByRole('radio', { name: 'Code' })).toHaveAttribute('aria-checked', 'true');
    await expect(w.getByRole('textbox', { name: 'Describe a task or ask a question' })).toBeVisible();
    await expect(w.getByRole('button', { name: 'Model: Graft Test Mini' })).toBeVisible();
    await expect(w.getByRole('button', { name: /Account menu for Robin/ })).toBeVisible();

    // Stored state: trimmed name, default model, and the key never exposed to the renderer.
    const state = await w.evaluate(async () => {
      const bridge = (window as unknown as { graft: { invoke(c: string, i?: unknown): Promise<{ ok: boolean; value: unknown }> } }).graft;
      const settings = (await bridge.invoke('settings:get')).value as { profile: { name: string }; onboarding: { step: string }; defaults: { model: { modelId: string } } };
      const providers = (await bridge.invoke('providers:list')).value as Array<Record<string, unknown>>;
      return { settings, providers };
    });
    expect(state.settings.profile.name).toBe('Robin');
    expect(state.settings.onboarding.step).toBe('done');
    expect(state.settings.defaults.model.modelId).toBe('graft-test-mini');
    expect(state.providers).toHaveLength(1);
    expect(state.providers[0]).toMatchObject({ kind: 'openai-compatible', hasKey: true, baseUrl: provider.url });
    expect(JSON.stringify(state.providers)).not.toContain(KEY);

    // Verification used the real key against the provider.
    expect(provider.requests.some((r) => r.path === '/v1/models' && r.authorization === `Bearer ${KEY}`)).toBe(true);
  } finally {
    await graft.close();
    await provider.close();
  }
});

test('quitting mid-onboarding resumes at the same step with earlier answers kept', async () => {
  const userData = makeTempDir('graft-e2e-resume-data-');
  const graftHome = makeTempDir('graft-e2e-resume-home-');
  let graft = await launchGraft({ userData, graftHome });
  try {
    await nameAndPicture(graft.window, 'Sam');
    await graft.window.getByRole('radio', { name: /Ollama/ }).click();
    await graft.window.getByRole('button', { name: 'Continue' }).click();
    await expect(graft.window.getByRole('heading', { name: 'Connect to Ollama' })).toBeVisible();
  } finally {
    await graft.close();
  }

  graft = await launchGraft({ userData, graftHome });
  try {
    const w = graft.window;
    await expect(w.getByRole('heading', { name: 'Connect to Ollama' })).toBeVisible();
    await expect(w.getByRole('navigation', { name: 'Setup progress' }).getByRole('button', { name: /Provider \(done\)/ })).toBeVisible();

    // Back navigation keeps the chosen provider; the stepper jumps back to earlier steps.
    await w.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(w.getByRole('heading', { name: 'Choose a model provider' })).toBeVisible();
    await expect(w.getByRole('radio', { name: /Ollama/ })).toHaveAttribute('aria-checked', 'true');
    await w.getByRole('button', { name: 'Name (done)' }).click();
    await expect(w.getByLabel('Your name')).toHaveValue('Sam');
  } finally {
    await graft.close();
  }
});
