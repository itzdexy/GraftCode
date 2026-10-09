import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchGraft, type LaunchedApp } from './support/launch';
import { MockProvider } from './support/mockProvider';
import { completeOnboarding, makeGitProject } from './support/onboard';

test('file tabs preserve drafts on switching and closing and restore per-file modes after restart', async () => {
  const project = makeGitProject({ 'notes.txt': 'original notes', 'other.txt': 'other file contents' });
  const provider = await MockProvider.start();
  let graft: LaunchedApp | undefined;
  try {
    graft = await launchGraft();
    await completeOnboarding(graft, provider, { project });
    let w = graft.window;
    provider.script({ text: 'Workspace tabs ready.' });
    const composer = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
    await composer.fill('Open this project'); await composer.press('Enter');
    await expect(w.getByText('Workspace tabs ready.', { exact: true })).toBeVisible();
    await w.getByRole('button', { name: 'More actions' }).click();
    await w.getByRole('menuitem', { name: /^Files/ }).click();
    await w.getByRole('tree', { name: 'Files' }).getByRole('button', { name: /^notes.txt/ }).first().click();
    await w.getByRole('button', { name: 'Edit file', exact: true }).click();
    await w.getByRole('textbox', { name: 'Edit notes.txt' }).focus();
    await w.keyboard.press('Control+A'); await w.keyboard.type('kept tab draft');
    await expect(w.getByRole('status').filter({ hasText: 'Draft backed up on this device.' })).toBeVisible();

    await w.getByRole('tree', { name: 'Files' }).getByRole('button', { name: /^other.txt/ }).first().click();
    const tabs = w.getByRole('tablist', { name: 'Open files' });
    await expect(tabs.getByRole('tab')).toHaveCount(2);
    await tabs.getByRole('tab', { name: /^notes.txt/ }).click();
    await expect(w.getByRole('textbox', { name: 'Edit notes.txt' })).toBeVisible();
    await expect(w.locator('.monaco-editor .view-lines')).toContainText('kept tab draft');

    // Arrow navigation switches files and remembers their own preview/edit mode.
    await tabs.getByRole('tab', { name: /^notes.txt/ }).focus();
    await w.keyboard.press('ArrowRight');
    await expect(tabs.getByRole('tab', { name: 'other.txt', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(w.getByRole('button', { name: 'Edit file', exact: true })).toBeVisible();
    await w.keyboard.press('ArrowLeft');
    await expect(w.getByRole('textbox', { name: 'Edit notes.txt' })).toBeVisible();
    await tabs.getByRole('button', { name: 'Close tab notes.txt', exact: true }).click();
    await expect(tabs.getByRole('tab')).toHaveCount(1);
    await expect(w.getByRole('button', { name: 'Open draft notes.txt', exact: true })).toBeVisible();
    expect(fs.readFileSync(path.join(project, 'notes.txt'), 'utf8')).toBe('original notes');
    await w.getByRole('button', { name: 'Open draft notes.txt', exact: true }).click();
    await expect(w.getByRole('textbox', { name: 'Edit notes.txt' })).toBeVisible();
    await expect(w.locator('.monaco-editor .view-lines')).toContainText('kept tab draft');

    const layout = await w.evaluate(() => localStorage.getItem('graft.workspace-layout.v1'));
    expect(layout).toContain('notes.txt');
    expect(layout).not.toContain('kept tab draft');
    const { userData, graftHome } = graft;
    await graft.close(); graft = undefined;
    graft = await launchGraft({ userData, graftHome }); w = graft.window;
    await w.getByText('Scripted title', { exact: true }).first().click();
    await expect(w.getByText('Workspace tabs ready.', { exact: true })).toBeVisible();
    await w.getByRole('button', { name: 'More actions' }).click();
    await w.getByRole('menuitem', { name: /^Files/ }).click();
    const restoredTabs = w.getByRole('tablist', { name: 'Open files' });
    await expect(restoredTabs.getByRole('tab')).toHaveCount(2);
    await expect(w.getByRole('textbox', { name: 'Edit notes.txt' })).toBeVisible();
    await expect(w.locator('.monaco-editor .view-lines')).toContainText('kept tab draft');
    await restoredTabs.getByRole('tab', { name: /^notes.txt/ }).focus();
    await w.keyboard.press('Delete');
    await expect(restoredTabs.getByRole('tab', { name: 'other.txt', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(w.getByRole('button', { name: 'Edit file', exact: true })).toBeVisible();
    await expect(w.getByRole('button', { name: 'Open draft notes.txt', exact: true })).toBeVisible();
    await w.screenshot({ path: test.info().outputPath('workspace-tabs-restored.png') });
  } finally {
    await graft?.close();
    await provider.close();
  }
});
