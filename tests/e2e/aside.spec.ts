import { expect, test, type Locator, type Page } from '@playwright/test';
import { launchGraft, type LaunchedApp } from './support/launch';
import { MockProvider } from './support/mockProvider';
import { completeOnboarding, makeGitProject } from './support/onboard';

let provider: MockProvider;
let graft: LaunchedApp;

test.beforeEach(async () => {
  provider = await MockProvider.start();
  graft = await launchGraft();
  await completeOnboarding(graft, provider, { project: makeGitProject({ 'notes.txt': 'hello\n' }) });
});

test.afterEach(async () => {
  await graft.close();
  await provider.close();
});

/** The message box of the session on screen, idle or working (its label says which), with or without its menu open. */
function messageBox(w: Page): Locator {
  const name = /^(Ask anything|Queue a message)/;
  return w.getByRole('textbox', { name }).or(w.getByRole('combobox', { name }));
}

/** What a chat request sent as its messages, as one text. */
const sent = (body: unknown): string => JSON.stringify((body as { messages: unknown }).messages);

test('a side question is answered while Graft works, beside the conversation and never in it', async () => {
  const w = graft.window;
  provider.script({ text: 'Thinking about a long answer', chunkDelayMs: 40, hold: true }, { text: 'It is reading notes.txt.' }, { text: 'Second answer.' });
  const home = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await home.fill('Start something long');
  await home.press('Enter');
  await expect(w.getByText('Thinking about a long answer')).toBeVisible();

  // Asked in the middle of the turn: it is answered at once, and the turn goes on.
  await messageBox(w).fill('/btw what are you doing right now?');
  await messageBox(w).press('Enter');
  const asides = w.getByRole('list', { name: 'Side questions' });
  await expect(asides.getByText('what are you doing right now?')).toBeVisible();
  await expect(asides.getByText('It is reading notes.txt.')).toBeVisible();
  await expect(asides.getByText('Kept out of the conversation')).toBeVisible();
  await expect(w.getByRole('button', { name: 'Stop' })).toBeVisible();
  await expect(w.getByRole('list', { name: 'Queued messages' })).toHaveCount(0);
  await expect(messageBox(w)).toHaveValue('');
  const conversation = w.getByRole('log', { name: 'Conversation' });
  await expect(conversation.getByText('what are you doing right now?')).toHaveCount(0);
  await expect(conversation.getByText('It is reading notes.txt.')).toHaveCount(0);

  // The model was asked with the conversation as reading matter, the question after it, and no tools.
  const asked = provider.chatRequests().at(-1)!.body as { tools?: unknown[]; messages: Array<{ role: string }> };
  expect(asked.tools ?? []).toEqual([]);
  expect(asked.messages.map((m) => m.role)).toEqual(['system', 'user']);
  expect(sent(asked)).toMatch(/side question/i);
  expect(sent(asked)).toContain('Start something long');
  expect(sent(asked)).toContain('what are you doing right now?');

  const closed = provider.waitForHeldStreamClosed();
  await w.getByRole('button', { name: 'Stop' }).click();
  await closed;
  await expect(w.getByText('Stopped.')).toBeVisible();

  // The next message goes to the model without the question or its answer: they were never in the conversation.
  await messageBox(w).fill('Try again');
  await messageBox(w).press('Enter');
  await expect(w.getByText('Second answer.')).toBeVisible();
  const next = sent(provider.chatRequests().at(-1)!.body);
  expect(next).toContain('Try again');
  expect(next).not.toContain('what are you doing right now?');
  expect(next).not.toContain('It is reading notes.txt.');

  // The answer can be copied, and the card goes when it is dismissed.
  await expect(asides.getByRole('button', { name: 'Copy the answer' })).toBeVisible();
  await asides.getByRole('button', { name: 'Dismiss' }).click();
  await expect(w.getByRole('list', { name: 'Side questions' })).toHaveCount(0);

  // With nothing after it, the command says what is missing and what was typed stays in the box.
  await messageBox(w).fill('/btw ');
  await messageBox(w).press('Enter');
  await expect(w.getByText(/Type the question after \/btw/)).toBeVisible();
  await expect(messageBox(w)).toHaveValue('/btw ');
  await expect(w.getByRole('list', { name: 'Side questions' })).toHaveCount(0);
  expect(provider.chatRequests()).toHaveLength(3);
});

test('the command menu offers the side question', async () => {
  const w = graft.window;
  provider.script({ text: 'First reply.' });
  const home = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await home.fill('hello');
  await home.press('Enter');
  await expect(w.getByText('First reply.', { exact: true })).toBeVisible();

  await messageBox(w).fill('/bt');
  const option = w.getByRole('option', { name: /\/btw/ });
  await expect(option).toBeVisible();
  await expect(option).toContainText('kept out of it');
});
