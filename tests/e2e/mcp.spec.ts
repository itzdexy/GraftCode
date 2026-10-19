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
    await w.getByRole('tab', { name: 'Integrations' }).click();
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

test('a permission set for one tool of a server decides its calls, whatever the server says about the tool', async () => {
  const provider = await MockProvider.start();
  const project = makeGitProject();
  const graft = await launchGraft();
  const w = graft.window;
  try {
    await completeOnboarding(graft, provider, { project });
    await w.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Customize' }).click();
    await w.getByRole('tab', { name: 'Integrations' }).click();
    await w.getByRole('button', { name: 'Add server' }).click();
    const dialog = w.getByRole('dialog', { name: 'Add MCP server' });
    await dialog.getByLabel('Name').fill('test');
    await dialog.getByLabel('Command').fill(process.execPath);
    await dialog.getByLabel('Arguments').fill(FIXTURE);
    // A new server is not handed this computer's keys and tokens unless that is chosen.
    await expect(dialog.getByLabel("What it gets from this computer's environment")).toHaveValue('no-secrets');
    await expect(dialog.getByText(/It still runs as you and can read your files\./)).toBeVisible();
    fs.mkdirSync(SHOTS, { recursive: true });
    await w.screenshot({ path: path.join(SHOTS, 'customize-mcp-add.png') });
    await dialog.getByRole('button', { name: 'Add server' }).click();
    await expect(dialog).toBeHidden();

    const list = w.getByRole('list', { name: 'MCP servers' });
    await expect(list.getByText('Connected · 2 tools')).toBeVisible();
    await list.getByRole('button', { name: /test/ }).first().click();
    // "shout" calls itself read-only, which Auto mode would take at its word: the user says never.
    await expect(list.getByLabel('Permission for shout')).toHaveValue('default');
    await list.getByLabel('Permission for shout').selectOption('deny');
    await expect(list.getByLabel('Permission for shout')).toHaveValue('deny');
    // "save-note" changes something and would ask in every mode: the user allows it.
    await list.getByLabel('Permission for save-note').selectOption('allow');
    await expect(list.getByLabel('Permission for save-note')).toHaveValue('allow');
    fs.mkdirSync(SHOTS, { recursive: true });
    await list.getByLabel('Permission for save-note').scrollIntoViewIfNeeded();
    await w.screenshot({ path: path.join(SHOTS, 'customize-mcp-permissions.png') });
    // The page never scrolls sideways.
    expect(await w.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    provider.script(
      { toolCalls: [{ name: 'mcp__test__shout', input: { text: 'quiet please' } }] },
      { toolCalls: [{ name: 'mcp__test__save_note', input: { note: 'remember' } }] },
      { text: 'One refused, one done.' }
    );
    await w.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'New' }).click();
    await w.getByRole('button', { name: /Permission mode/ }).click();
    await w.getByRole('menuitem', { name: /^Auto(?!-)/ }).click();
    const composer = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
    await composer.fill('Use the test tools');
    await composer.press('Enter');
    await expect(w.getByText('One refused, one done.')).toBeVisible();
    // Nothing was asked: one call was refused by the rule and the other ran on it.
    await expect(w.getByRole('alertdialog')).toHaveCount(0);
    const bodies = provider.chatRequests().map((r) => JSON.stringify(r.body));
    expect(bodies[1]).toContain('Permission denied: Blocked by the rule mcp__test__shout (user settings).');
    expect(bodies[1]).not.toContain('QUIET PLEASE');
    expect(bodies[2]).toContain('Saved: remember');

    // The same rules are the ones Settings → Permissions lists.
    const rules = await w.evaluate(async () => {
      const bridge = (window as unknown as { graft: { invoke(c: string, i: unknown): Promise<{ value: Array<{ scope: string; allow: string[]; deny: string[] }> }> } }).graft;
      return (await bridge.invoke('permissions:get', { projectPath: null })).value.find((scoped) => scoped.scope === 'user');
    });
    expect(rules).toMatchObject({ allow: ['mcp__test__save_note'], deny: ['mcp__test__shout'] });
  } finally {
    await graft.close();
    await provider.close();
  }
});

const RICH = path.resolve(__dirname, '..', 'fixtures', 'mcp-rich-server.mjs');

test('a server’s prompts become slash commands, and the agent reads what it publishes', async () => {
  const provider = await MockProvider.start();
  const project = makeGitProject();
  const graft = await launchGraft();
  const w = graft.window;
  try {
    await completeOnboarding(graft, provider, { project });

    await w.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Customize' }).click();
    await w.getByRole('tab', { name: 'Integrations' }).click();
    await w.getByRole('button', { name: 'Add server' }).click();
    const dialog = w.getByRole('dialog', { name: 'Add MCP server' });
    await dialog.getByLabel('Name').fill('rich');
    await dialog.getByLabel('Command').fill(process.execPath);
    await dialog.getByLabel('Arguments').fill(RICH);
    await dialog.getByRole('button', { name: 'Add server' }).click();
    await expect(dialog).toBeHidden();

    // The row says what the server offers besides tools.
    const list = w.getByRole('list', { name: 'MCP servers' });
    await expect(list.getByText('Connected · 2 tools · 1 prompt · resources')).toBeVisible();
    // It goes by the name and the icon the server gives itself, with the name it has in the settings beside them.
    await expect(list.getByText('Graft Rich Notes')).toBeVisible();
    await expect(list.locator('img[src^="data:image/svg+xml"]')).toHaveCount(1);
    await list.getByRole('button', { name: /rich/ }).first().click();
    await expect(list.getByText('/mcp__rich__review <file>')).toBeVisible();

    // The prompt is a command: the server fills it in, and the model gets the result.
    provider.script(
      { text: 'Reviewed.' },
      { toolCalls: [{ name: 'mcp__resources__read', input: { server: 'rich', uri: 'notes://readme' } }] },
      { text: 'The readme says notes live here.' }
    );
    await w.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'New' }).click();
    await w.getByRole('button', { name: /Permission mode/ }).click();
    await w.getByRole('menuitem', { name: /^Auto(?!-)/ }).click();
    const composer = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
    await composer.fill('/mcp__rich__review src/app.ts');
    await composer.press('Enter');
    await expect(w.getByText('Reviewed.')).toBeVisible();
    // The transcript shows what was typed, not the text the server sent.
    await expect(w.getByText('/mcp__rich__review src/app.ts').first()).toBeVisible();

    // The session's Connectors card opens to the server, by its own name.
    const connectors = w.getByRole('complementary', { name: 'Session details' }).getByRole('group', { name: 'Connectors' });
    await connectors.getByRole('button', { name: /^Connectors/ }).click();
    await connectors.getByRole('button', { name: /^Graft Rich Notes: / }).click();
    await expect(connectors.getByRole('list', { name: 'Tools of Graft Rich Notes' })).toBeVisible();

    const box = w.getByRole('combobox', { name: /Ask anything/ }).or(w.getByRole('textbox', { name: /Ask anything/ }));
    await box.fill('What does the readme resource say?');
    await box.press('Enter');
    await expect(w.getByText('The readme says notes live here.')).toBeVisible();

    const bodies = provider.chatRequests().map((r) => JSON.stringify(r.body));
    expect(bodies[0]).toContain('Please review src/app.ts for bugs.');
    // The server's own notes reach the prompt as its words, and the resource tools are offered.
    expect(bodies[0]).toContain('Call \\"count\\" before anything else.');
    expect(bodies[0]).toContain('written by the servers themselves');
    expect(bodies[0]).toContain('mcp__resources__read');
    expect(bodies[2]).toContain('Notes live here.');
  } finally {
    await graft.close();
    await provider.close();
  }
});
