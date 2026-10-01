import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchGraft } from './support/launch';
import { MockProvider } from './support/mockProvider';
import { completeOnboarding, makeGitProject } from './support/onboard';

const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'mcp-test-server.mjs');
const SHOTS = path.join(__dirname, '..', '..', 'test-results', 'shots');

test('connects a local MCP server from Customize and the agent uses its tools', async () => {
  const provider = await MockProvider.start();
  const project = makeGitProject();
  const graft = await launchGraft();
  const w = graft.window;
  try {
    await completeOnboarding(graft, provider, { project });

    // Add the server.
    await w.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Customize' }).click();
    await w.getByRole('tab', { name: 'MCP servers' }).click();
    await w.getByRole('button', { name: 'Add server' }).click();
    const dialog = w.getByRole('dialog', { name: 'Add MCP server' });
    await dialog.getByLabel('Name').fill('test');
    await dialog.getByLabel('Command').fill(process.execPath);
    await dialog.getByLabel('Arguments').fill(FIXTURE);
    await dialog.getByLabel('Environment variables').fill('GRAFT_TEST_TOKEN=not-shown');
    await dialog.getByRole('button', { name: 'Add server' }).click();
    await expect(dialog).toBeHidden();

    const list = w.getByRole('list', { name: 'MCP servers' });
    await expect(list.getByText('Connected · 2 tools')).toBeVisible();
    await list.getByRole('button', { name: /test/ }).first().click();
    await expect(list.getByText('shout', { exact: true })).toBeVisible();
    await expect(list.getByText('save-note', { exact: true })).toBeVisible();
    fs.mkdirSync(SHOTS, { recursive: true });
    await w.screenshot({ path: path.join(SHOTS, 'customize-mcp.png') });

    // The secret value stays in main: the UI only sees variable names.
    const listed = await w.evaluate(async () => {
      const bridge = (window as unknown as { graft: { invoke(c: string, i: unknown): Promise<{ value: unknown }> } }).graft;
      return JSON.stringify((await bridge.invoke('mcp:list', { projectPath: null })).value);
    });
    expect(listed).toContain('GRAFT_TEST_TOKEN');
    expect(listed).not.toContain('not-shown');

    // In Auto mode a session calls the read-only tool without asking, and asks before the other one.
    provider.script(
      { toolCalls: [{ name: 'mcp__test__shout', input: { text: 'quiet please' } }] },
      { toolCalls: [{ name: 'mcp__test__save_note', input: { note: 'remember' } }] },
      { text: 'Both tools worked.' }
    );
    await w.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'New' }).click();
    await w.getByRole('button', { name: /Permission mode/ }).click();
    await w.getByRole('menuitem', { name: /^Auto(?!-)/ }).click();
    const composer = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
    await composer.fill('Use the test tools');
    await composer.press('Enter');
    const card = w.getByRole('alertdialog', { name: /test · save-note/ });
    await expect(card).toBeVisible();
    await expect(card.getByText('"note": "remember"')).toBeVisible();
    await card.getByRole('button', { name: /Allow once/ }).click();
    await expect(w.getByText('Both tools worked.')).toBeVisible();

    const bodies = provider.chatRequests().map((r) => JSON.stringify(r.body));
    expect(bodies[0]).toContain('mcp__test__shout');
    expect(bodies[1]).toContain('QUIET PLEASE');
    expect(bodies[2]).toContain('Saved: remember');
  } finally {
    await graft.close();
    await provider.close();
  }
});
