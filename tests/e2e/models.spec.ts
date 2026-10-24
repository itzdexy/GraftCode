import { expect, test } from '@playwright/test';
import { launchGraft, type LaunchedApp } from './support/launch';
import { MockProvider } from './support/mockProvider';
import { completeOnboarding } from './support/onboard';

let provider: MockProvider;
let graft: LaunchedApp;

test.afterEach(async () => {
  await graft.close();
  await provider.close();
});

test('the Models page has a section for the picture, video, voice and transcription models a provider lists', async () => {
  // A server that lists media models beside its chat models, as Together, DeepInfra or a local server do.
  provider = await MockProvider.start({ extraModels: ['black-forest-labs/FLUX.1-schnell', 'Wan-AI/Wan2.2-T2V-A14B', 'hexgrad/Kokoro-82M', 'whisper-large-v3'] });
  graft = await launchGraft();
  const w = graft.window;
  await completeOnboarding(graft, provider);

  await w.getByRole('button', { name: /^Account menu for/ }).click();
  await w.getByRole('menuitem', { name: 'Settings' }).click();
  const settings = w.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name: 'Models', exact: true }).click();

  const images = settings.getByRole('region', { name: 'Image models' });
  await expect(images.getByText('black-forest-labs/FLUX.1-schnell')).toBeVisible();
  // This server isn't one Graft makes pictures through, and the section says so instead of offering Use.
  await expect(images.getByText('Graft makes pictures through OpenRouter, OpenAI or Google.')).toBeVisible();
  await expect(images.getByRole('button', { name: /^Use for images/ })).toHaveCount(0);
  await expect(settings.getByRole('region', { name: 'Video models' }).getByText('Wan-AI/Wan2.2-T2V-A14B')).toBeVisible();
  await expect(settings.getByRole('region', { name: 'Voices' }).getByText('hexgrad/Kokoro-82M')).toBeVisible();
  await expect(settings.getByRole('region', { name: 'Transcription' }).getByText('whisper-large-v3')).toBeVisible();
  await expect(settings.getByRole('region', { name: 'Music and sound' })).toHaveCount(0);

  // Typing narrows every section at once.
  await settings.getByRole('searchbox', { name: 'Find an image, video or audio model' }).fill('kokoro');
  await expect(settings.getByRole('region', { name: 'Voices' })).toBeVisible();
  await expect(settings.getByRole('region', { name: 'Image models' })).toHaveCount(0);

  // The models to chat with are the chat models only.
  const chat = settings.getByRole('listbox', { name: 'Default model' });
  await expect(chat.getByRole('option', { name: /Graft Test Large/ })).toBeVisible();
  await expect(chat.getByRole('option', { name: /FLUX|Kokoro|Wan2|whisper/i })).toHaveCount(0);
});
