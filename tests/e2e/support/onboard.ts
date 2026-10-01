import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import type { LaunchedApp } from './launch';
import { makeTempDir } from './launch';
import type { MockProvider } from './mockProvider';

/** A git repository with one committed file, for sessions that edit and rewind. */
export function makeGitProject(files: Record<string, string> = { 'notes.txt': 'hello\n' }): string {
  const dir = makeTempDir('graft-e2e-project-');
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'user.name', 'E2E');
  git('config', 'core.autocrlf', 'false');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  return dir;
}

/** Replaces the native folder picker so tests can "choose" a folder. */
export async function stubFolderPicker(graft: LaunchedApp, folder: string): Promise<void> {
  await graft.app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] });
  }, folder);
}

/** Completes onboarding against the mock provider, optionally choosing a first project folder. */
export async function completeOnboarding(graft: LaunchedApp, provider: MockProvider, options: { name?: string; project?: string } = {}): Promise<void> {
  const w = graft.window;
  await expect(w.getByRole('heading', { name: 'What should we call you?' })).toBeVisible();
  await w.getByLabel('Your name').fill(options.name ?? 'Robin');
  await w.keyboard.press('Enter');
  await w.getByRole('button', { name: 'Skip' }).click();
  await w.getByRole('radio', { name: /Custom endpoint/ }).click();
  await w.getByRole('button', { name: 'Continue' }).click();
  await w.getByLabel('Base URL').fill(provider.url);
  await w.getByRole('button', { name: 'Verify' }).click();
  await expect(w.getByText(/Connected\./)).toBeVisible();
  await w.getByRole('button', { name: 'Continue' }).click();
  await expect(w.getByRole('option', { name: /Graft Test Large/ })).toBeVisible();
  if (options.project) {
    await stubFolderPicker(graft, options.project);
    await w.getByRole('button', { name: 'Choose a folder' }).click();
    await expect(w.getByText(options.project)).toBeVisible();
  }
  await w.getByRole('button', { name: 'Start using Graft' }).click();
  await expect(w.getByRole('heading', { name: /^Welcome/ })).toBeVisible();
}
