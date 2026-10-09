import { expect, test } from '@playwright/test';
import { launchGraft, type LaunchedApp } from './support/launch';
import { MockProvider } from './support/mockProvider';
import { completeOnboarding } from './support/onboard';

let graft: LaunchedApp | undefined;
let provider: MockProvider | undefined;
test.afterEach(async () => { await graft?.close(); await provider?.close(); });

test('catalog refresh updates provider metadata and the real settings controls persist across restart', async () => {
  provider = await MockProvider.start();
  graft = await launchGraft();
  await completeOnboarding(graft, provider);
  const openProviders = async (): Promise<void> => {
    const w = graft!.window;
    await w.getByRole('button', { name: /^Account menu for/ }).click();
    await w.getByRole('menuitem', { name: 'Settings' }).click();
    await w.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name: 'Providers', exact: true }).click();
  };
  await openProviders();
  await expect(graft.window.getByRole('heading', { name: 'Model catalog' })).toBeVisible();
  // Inject a transport fixture in the main process, leaving real service, persistence, IPC and UI in place.
  await graft.app.evaluate(() => {
    const original = globalThis.fetch;
    globalThis.fetch = (input, options) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return url === 'https://models.dev/api.json' ? Promise.resolve(new Response(JSON.stringify({ acme: { name: 'Catalog fixture provider', api: 'https://acme.test/v1', env: [], models: {
        alpha: { id: 'alpha', name: 'Alpha', tool_call: true, limit: { context: 128000, output: 8192 } }
      } } }), { headers: { etag: 'fixture-v1' } })) : original(input, options);
    };
  });
  await graft.window.getByRole('button', { name: 'Refresh catalog', exact: true }).click();
  await expect(graft.window.getByText(/^Last validated:/)).toBeVisible();
  await graft.window.getByRole('combobox', { name: 'Model catalog refresh interval' }).selectOption('6');
  await graft.window.getByRole('switch', { name: 'Automatically refresh model metadata' }).click();
  await expect(graft.window.getByRole('switch', { name: 'Automatically refresh model metadata' })).not.toBeChecked();
  const { userData, graftHome } = graft;
  await graft.close();
  graft = await launchGraft({ userData, graftHome });
  await expect(graft.window.getByRole('button', { name: /^Account menu for/ })).toBeVisible();
  await openProviders();
  await expect(graft.window.getByRole('combobox', { name: 'Model catalog refresh interval' })).toHaveValue('6');
  await expect(graft.window.getByRole('switch', { name: 'Automatically refresh model metadata' })).not.toBeChecked();
  await expect(graft.window.getByText(/^Last validated:/)).toBeVisible();
  const presets = await graft.window.evaluate(async () => {
    const bridge = (window as unknown as { graft: { invoke(channel: string): Promise<{ ok: boolean; value: Array<{ id: string }> }> } }).graft;
    return (await bridge.invoke('providers:presets')).value;
  });
  expect(presets.some((p) => p.id === 'acme')).toBe(true);
  await graft.window.screenshot({ path: test.info().outputPath('catalog-settings.png') });
});

test('native shutdown evidence disables a retired model without silently replacing the selected model', async () => {
  provider = await MockProvider.start();
  graft = await launchGraft();
  await completeOnboarding(graft, provider);
  await graft.app.evaluate(() => {
    const original = globalThis.fetch;
    globalThis.fetch = (input, options) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return url === 'https://api.openai.com/v1/models' ? Promise.resolve(new Response(JSON.stringify({ data: [
        { id: 'gpt-retired-fixture', name: 'Retired fixture', shutdown_date: '2020-01-01' },
        { id: 'gpt-scheduled-fixture', name: 'Scheduled fixture', shutdown_date: '2099-01-01' }
      ] }))) : original(input, options);
    };
  });
  const selected = await graft.window.evaluate(async () => {
    const bridge = (window as unknown as { graft: { invoke(channel: string, input?: unknown): Promise<{ ok: boolean; value: unknown }> } }).graft;
    const before = (await bridge.invoke('settings:get')).value as { defaults: { model: unknown } };
    const added = await bridge.invoke('providers:add', { kind: 'openai', preset: null, label: 'Lifecycle fixture', baseUrl: null, apiKey: 'fixture-key' });
    if (!added.ok) throw new Error('Could not add lifecycle fixture');
    const listed = await bridge.invoke('models:list', { refresh: true });
    if (!listed.ok) throw new Error('Could not discover lifecycle fixture');
    return before.defaults.model;
  });
  const w = graft.window;
  await w.getByRole('button', { name: /^Account menu for/ }).click();
  await w.getByRole('menuitem', { name: 'Settings' }).click();
  await w.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name: 'Models', exact: true }).click();
  const list = w.getByRole('listbox', { name: 'Default model' });
  const retired = list.getByRole('option', { name: /Retired fixture/ });
  await expect(retired).toHaveAttribute('aria-disabled', 'true');
  await expect(retired).toHaveAttribute('title', /OpenAI announced shutdown on 2020-01-01/);
  await expect(list.getByRole('option', { name: /Scheduled fixture/ })).toHaveAttribute('aria-disabled', 'false');
  // Dispatch a real pointer click despite ARIA-disabled to exercise the handler's guard too.
  await retired.click({ force: true });
  const after = await w.evaluate(async () => {
    const bridge = (window as unknown as { graft: { invoke(channel: string): Promise<{ value: { defaults: { model: unknown } } }> } }).graft;
    return (await bridge.invoke('settings:get')).value.defaults.model;
  });
  expect(after).toEqual(selected);
});
