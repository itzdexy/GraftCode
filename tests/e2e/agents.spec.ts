import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchGraft, type LaunchedApp } from './support/launch';
import { MockProvider } from './support/mockProvider';
import { completeOnboarding, makeGitProject } from './support/onboard';

const SHOTS = path.join(__dirname, '..', '..', 'test-results', 'shots');
/** The message box of a code session with a project folder, by its label. */
const SESSION_BOX = /^Ask anything/;

async function shot(w: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true });
  await w.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

let provider: MockProvider;
let graft: LaunchedApp;
let project: string;

test.beforeEach(async () => {
  provider = await MockProvider.start();
  project = makeGitProject({ 'notes.txt': 'hello\n' });
  graft = await launchGraft();
  await completeOnboarding(graft, provider, { project });
});

test.afterEach(async () => {
  await graft.close();
  await provider.close();
});

/** What the model was last sent by the user side, as text. */
function lastMessage(request: { body: unknown }): string {
  return JSON.stringify((request.body as { messages: unknown[] }).messages.slice(-1));
}

test('a group of agents runs as a graph in the Agents panel, and each agent opens to what it did', async () => {
  const w = graft.window;
  provider.script(
    {
      toolCalls: [
        {
          name: 'RunAgents',
          input: {
            goal: 'Understand the notes',
            agents: [
              { id: 'read', role: 'explorer', task: 'Read the notes', prompt: 'Read notes.txt and report what it says.' },
              { id: 'sum', role: 'explorer', task: 'Summarize the notes', prompt: 'Summarize what the notes say in one line.', depends_on: ['read'] }
            ]
          }
        }
      ]
    },
    // The two agents, in the order the graph runs them: the second waits for the first.
    { text: 'notes.txt says hello.' },
    { text: 'One line: the notes say hello.' },
    { text: 'The notes say hello.' }
  );
  const composer = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await composer.fill('Split this up between agents');
  await composer.press('Enter');

  // The panel opens by itself when the group starts, and shows both agents finished.
  const panel = w.getByRole('region', { name: 'Agents', exact: true });
  await expect(panel).toBeVisible();
  await expect(panel.getByText('Understand the notes')).toBeVisible();
  const read = panel.getByRole('button', { name: /^Read the notes: Explorer, done/ });
  const sum = panel.getByRole('button', { name: /^Summarize the notes: Explorer, done/ });
  await expect(read).toBeVisible();
  await expect(sum).toBeVisible();
  await expect(panel.getByText(/2 of 2 done/)).toBeVisible();
  await expect(w.getByText('The notes say hello.', { exact: true })).toBeVisible();

  // An agent opens to its model, its brief and its report.
  await read.click();
  const inspector = panel.getByRole('region', { name: 'Agent: Read the notes' });
  await expect(inspector.getByText('notes.txt says hello.')).toBeVisible();
  await expect(inspector.getByText('Graft Test Large')).toBeVisible();
  // Why this model: the reason the router gave.
  await expect(inspector.getByText(/The session.s model \(no model is assigned/)).toBeVisible();
  await inspector.getByRole('button', { name: 'Brief' }).click();
  await expect(inspector.getByText('Read notes.txt and report what it says.')).toBeVisible();
  await shot(w, 'agents-panel');

  // The second agent was given the first one's report; the main agent got both.
  const requests = provider.chatRequests();
  expect(requests).toHaveLength(4);
  expect(lastMessage(requests[2]!)).toContain('notes.txt says hello.');
  expect(lastMessage(requests[3]!)).toContain('One line: the notes say hello.');
  // The turn folds into one line that names the group.
  await expect(w.getByRole('button', { name: /^Ran 2 agents/ })).toBeVisible();

  // The agents are still there after the app's window is loaded again and the session reopened from storage.
  await graft.window.reload();
  await w.getByRole('navigation', { name: 'Main' }).getByText('Scripted title', { exact: true }).click();
  await expect(w.getByText('The notes say hello.', { exact: true })).toBeVisible();
  await w.getByRole('button', { name: 'Agents', exact: true }).click();
  await expect(w.getByRole('region', { name: 'Agents', exact: true }).getByRole('button', { name: /^Read the notes: Explorer, done/ })).toBeVisible();
});

test('a mission keeps going until the agent reports done and its check passes', async () => {
  const w = graft.window;
  provider.script({ text: 'Hi.' });
  const composer = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await composer.fill('hello');
  await composer.press('Enter');
  await expect(w.getByText('Hi.', { exact: true })).toBeVisible();

  // /mission opens the dialog with the objective filled in.
  provider.script(
    { text: 'Looking at the notes.' },
    { toolCalls: [{ name: 'MissionUpdate', input: { note: { kind: 'decision', text: 'The notes are fine as they are.' }, status: 'done', summary: 'The notes are finished.' } }] },
    { text: 'Reported the mission done.' }
  );
  const box = w.getByRole('combobox', { name: SESSION_BOX }).or(w.getByRole('textbox', { name: SESSION_BOX }));
  await box.fill('/mission Finish the notes');
  await box.press('Enter');
  const dialog = w.getByRole('dialog', { name: 'Start a mission' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Objective' })).toHaveValue('Finish the notes');
  await dialog.getByRole('textbox', { name: 'Must pass (optional)' }).fill('node -e "process.exit(0)"');
  await shot(w, 'mission-dialog');
  await dialog.getByRole('button', { name: 'Start mission' }).click();
  await expect(dialog).toBeHidden();

  // The first turn ends without finishing, so a second follows; it reports done, the check runs and passes.
  const bar = w.getByRole('region', { name: 'Mission', exact: true });
  await expect(bar.getByText(/Done in 2 turns · checks passed/)).toBeVisible({ timeout: 60_000 });
  await expect(w.getByText('The mission goes on')).toBeVisible();
  await expect(w.getByText('Reported the mission done.', { exact: true })).toBeVisible();
  await expect(w.getByText(/Checks passed/)).toBeVisible();

  // The bar opens to the check and the notebook.
  await bar.getByRole('button', { name: /Mission/ }).first().click();
  await expect(bar.getByText('The notes are fine as they are.')).toBeVisible();
  await expect(bar.getByText('The notes are finished.')).toBeVisible();
  await shot(w, 'mission-done');

  // Turn 1 got the objective with how a mission works; turn 2 got the mission restated.
  const requests = provider.chatRequests();
  expect(requests).toHaveLength(4);
  expect(lastMessage(requests[1]!)).toContain('This is a mission');
  expect(lastMessage(requests[2]!)).toContain('[Mission, turn 2 of 25]');
  // The mission tool was offered only once the mission was open.
  const toolsOf = (request: { body: unknown }): string[] => ((request.body as { tools?: Array<{ function: { name: string } }> }).tools ?? []).map((t) => t.function.name);
  expect(toolsOf(requests[0]!)).not.toContain('MissionUpdate');
  expect(toolsOf(requests[1]!)).toContain('MissionUpdate');
});
