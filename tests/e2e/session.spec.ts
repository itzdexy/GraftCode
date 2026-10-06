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

test('an edit turn asks for approval, applies the change and shows it in the transcript and status bar', async () => {
  const w = graft.window;
  provider.script(
    { text: 'Let me read the notes first.', toolCalls: [{ name: 'Read', input: { file_path: 'notes.txt' } }] },
    { toolCalls: [{ name: 'Edit', input: { file_path: 'notes.txt', old_string: 'hello', new_string: 'hello world' } }] },
    { text: 'Updated **notes.txt** so it says `hello world`.' }
  );

  const composer = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await composer.fill('Add "world" to the notes');
  await composer.press('Enter');

  // The session opens and the edit waits for approval with the exact diff.
  const card = w.getByRole('alertdialog', { name: 'Edit notes.txt' });
  await expect(card).toBeVisible();
  await expect(card.getByText('hello world')).toBeVisible();
  await expect(card.getByRole('button', { name: /Always allow/ })).toBeVisible();
  expect(fs.readFileSync(path.join(project, 'notes.txt'), 'utf8')).toBe('hello\n');
  await shot(w, 'session-permission');

  await card.getByRole('button', { name: /Allow once/ }).click();
  await expect(w.getByText('Updated notes.txt so it says')).toBeVisible();
  await expect(card).toBeHidden();
  expect(fs.readFileSync(path.join(project, 'notes.txt'), 'utf8')).toBe('hello world\n');

  // The turn's work folds into one summary line that expands to each step.
  const summary = w.getByRole('button', { name: /^Edited notes\.txt, read notes\.txt/ });
  await expect(summary).toBeVisible();
  await summary.click();
  await expect(w.getByRole('button', { name: /^Edited notes\.txt(?!,)/ })).toBeVisible();
  await expect(w.getByRole('button', { name: /^Read notes\.txt/ })).toBeVisible();

  // The status bar shows the branch and the diff counts.
  await expect(w.getByRole('img', { name: '1 line added, 1 removed' })).toBeVisible();
  await expect(w.getByRole('button', { name: 'Create PR' })).toBeVisible();

  // The sidebar lists the session under the project folder with its generated title.
  await expect(w.getByRole('navigation', { name: 'Main' }).getByText('Scripted title', { exact: true })).toBeVisible();
  await shot(w, 'session-done');

  // Two model requests carried tool results back; the edit result was not an error.
  const requests = provider.chatRequests();
  expect(requests).toHaveLength(3);
  const toolResults = JSON.stringify((requests[2]!.body as { messages: unknown[] }).messages.slice(-1));
  expect(toolResults).toContain('tool');
  expect(toolResults).not.toMatch(/"is_error":\s*true/);
});

test('Stop interrupts a streaming reply and the session accepts the next message', async () => {
  const w = graft.window;
  provider.script({ text: 'Thinking about a long answer', chunkDelayMs: 40, hold: true }, { text: 'Second answer.' });
  const composer = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await composer.fill('Start something long');
  await composer.press('Enter');

  await expect(w.getByText('Thinking about a long answer')).toBeVisible();
  const closed = provider.waitForHeldStreamClosed();
  await w.getByRole('button', { name: 'Stop' }).click();
  await closed;
  await expect(w.getByText('Stopped.')).toBeVisible();
  await expect(w.getByRole('button', { name: 'Stop' })).toBeHidden();

  const next = w.getByRole('textbox', { name: SESSION_BOX });
  await next.fill('Try again');
  await next.press('Enter');
  await expect(w.getByText('Second answer.')).toBeVisible();
  await shot(w, 'session-interrupted');
});

test('the agent asks a question; number keys pick an option and the answer goes back to the model', async () => {
  const w = graft.window;
  provider.script(
    {
      toolCalls: [
        {
          name: 'AskUserQuestion',
          input: {
            questions: [
              {
                question: 'Which file should I change?',
                header: 'File',
                options: [
                  { label: 'notes.txt', description: 'The notes file' },
                  { label: 'README.md', description: 'A new readme' }
                ]
              }
            ]
          }
        }
      ]
    },
    { text: 'Going with the readme.' }
  );
  const composer = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await composer.fill('Add some docs');
  await composer.press('Enter');

  const card = w.getByRole('group', { name: 'Question 1 of 1' });
  await expect(card.getByText('Which file should I change?')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Submit' })).toBeDisabled();
  await card.getByRole('radio', { name: /notes\.txt/ }).focus();
  await w.keyboard.press('2');
  await expect(card.getByRole('radio', { name: /README\.md/ })).toHaveAttribute('aria-checked', 'true');
  await shot(w, 'session-question');
  await card.getByRole('button', { name: 'Submit' }).click();
  await expect(w.getByText('Going with the readme.')).toBeVisible();
  const answer = JSON.stringify((provider.chatRequests().at(-1)!.body as { messages: unknown[] }).messages.slice(-1));
  expect(answer).toContain('README.md');
});

test('the session menu opens Files and keeps the computer awake; Bypass points to Settings until it is on', async () => {
  const w = graft.window;
  provider.script({ text: 'Hello.' });
  const composer = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await composer.fill('Say hello');
  await composer.press('Enter');
  await expect(w.getByText('Hello.', { exact: true })).toBeVisible();

  await w.getByRole('button', { name: 'More actions' }).click();
  await w.getByRole('menuitem', { name: /^Files/ }).click();
  const changes = w.getByRole('region', { name: 'Changes', exact: true });
  await expect(changes.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true');
  await w.keyboard.press('Control+Shift+F');
  await expect(changes).toBeHidden();

  await w.getByRole('button', { name: 'More actions' }).click();
  const awake = w.getByRole('menuitemcheckbox', { name: /Keep computer awake/ });
  await expect(awake).toHaveAttribute('aria-checked', 'false');
  await awake.click();
  await expect(awake).toHaveAttribute('aria-checked', 'true');
  await w.keyboard.press('Escape');
  const ids = await w.evaluate(async () => {
    const bridge = (window as unknown as { graft: { invoke(c: string): Promise<{ value: string[] }> } }).graft;
    return (await bridge.invoke('power:keepAwakeList')).value;
  });
  expect(ids).toHaveLength(1);

  await w.getByRole('button', { name: /Permission mode/ }).click();
  await w.getByRole('menuitem', { name: /Bypass \(off\)/ }).click();
  await expect(w.getByRole('heading', { level: 2, name: 'Permissions' })).toBeVisible();
});

test('typing / lists commands and Enter runs one without arguments', async () => {
  const w = graft.window;
  provider.script({ text: 'Hi.' });
  const composer = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await composer.fill('hello');
  await composer.press('Enter');
  await expect(w.getByText('Hi.', { exact: true })).toBeVisible();

  const box = w.getByRole('combobox', { name: SESSION_BOX }).or(w.getByRole('textbox', { name: SESSION_BOX }));
  await box.fill('/he');
  const list = w.getByRole('listbox', { name: 'Commands' });
  await expect(list.getByRole('option', { name: /\/help/ })).toBeVisible();
  await shot(w, 'session-slash');
  await box.press('Enter');
  await expect(w.getByText(/In the message box: @ mentions a file/)).toBeVisible();
  // The help output is local: no extra model request.
  expect(provider.chatRequests()).toHaveLength(1);
});

test('rewind restores the files and the conversation to before a message', async () => {
  const w = graft.window;
  provider.script(
    { toolCalls: [{ name: 'Read', input: { file_path: 'notes.txt' } }] },
    { toolCalls: [{ name: 'Write', input: { file_path: 'notes.txt', content: 'rewritten\n' } }] },
    { text: 'Rewrote the notes.' }
  );
  // Auto-edit mode applies edits without asking.
  await w.getByRole('button', { name: /Permission mode/ }).click();
  await w.getByRole('menuitem', { name: /Auto-edit/ }).click();
  const composer = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await composer.fill('Rewrite the notes');
  await composer.press('Enter');
  await expect(w.getByText('Rewrote the notes.')).toBeVisible();
  expect(fs.readFileSync(path.join(project, 'notes.txt'), 'utf8')).toBe('rewritten\n');

  // Rewind from the user message: preview, then restore both.
  const userMessage = w.getByText('Rewrite the notes', { exact: true });
  await userMessage.hover();
  await w.getByRole('button', { name: 'Rewind to here' }).click();
  const dialog = w.getByRole('dialog', { name: 'Rewind to this message?' });
  await expect(dialog.getByText('notes.txt')).toBeVisible();
  await expect(dialog.getByRole('radio', { name: /Files and conversation/ })).toHaveAttribute('aria-checked', 'true');
  await shot(w, 'session-rewind');
  await dialog.getByRole('button', { name: 'Rewind' }).click();
  await expect(dialog).toBeHidden();

  expect(fs.readFileSync(path.join(project, 'notes.txt'), 'utf8')).toBe('hello\n');
  await expect(w.getByText('Rewrote the notes.')).toBeHidden();
  // The rewound message returns to the composer for editing.
  await expect(w.getByRole('textbox', { name: SESSION_BOX })).toHaveValue('Rewrite the notes');
});

test('a plan is edited before it is approved, and stays above the message box', async () => {
  const w = graft.window;
  provider.script(
    { toolCalls: [{ name: 'ExitPlanMode', input: { plan: '## Add a greeting\n\n1. Create hello.txt' } }] },
    { text: 'Following your version.' }
  );
  const composer = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await composer.fill('/plan add a greeting file');
  await composer.press('Enter');

  // /plan switched the session to Plan mode, and the plan waits for approval.
  const card = w.getByRole('alertdialog', { name: 'Approve this plan?' });
  await expect(card.getByText('Create hello.txt')).toBeVisible();
  await expect(w.getByRole('button', { name: /Permission mode: Plan/ })).toBeVisible();
  expect(JSON.stringify(provider.chatRequests()[0]!.body)).toContain('Plan this before changing anything: add a greeting file');

  // A plan edited down to nothing can't be approved; the user's version can.
  await card.getByRole('button', { name: 'Edit plan' }).click();
  const box = card.getByRole('textbox', { name: 'Plan' });
  await box.fill('');
  await expect(card.getByRole('button', { name: /Approve plan/ })).toBeDisabled();
  await box.fill('## Add a greeting\n\n1. Create hello.txt\n2. Say hello in Norwegian too');
  await shot(w, 'session-plan-edit');
  await card.getByRole('button', { name: /Approve plan/ }).click();
  await expect(w.getByText('Following your version.')).toBeVisible();
  const told = JSON.stringify(provider.chatRequests()[1]!.body);
  expect(told).toContain('carry out their version');
  expect(told).toContain('Say hello in Norwegian too');

  // The plan stays above the message box, as the user approved it.
  await w.getByRole('button', { name: /^Plan: Add a greeting/ }).click();
  const dialog = w.getByRole('dialog', { name: 'Plan' });
  await expect(dialog.getByText('Say hello in Norwegian too')).toBeVisible();
  await shot(w, 'session-plan');
});
