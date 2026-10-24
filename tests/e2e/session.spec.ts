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

  // The diff counts and Create PR: in the details column while it is open, in the status bar under the transcript otherwise.
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

  // The transcript shows the plan that was agreed on, not the one first offered.
  const agreed = w.getByRole('region', { name: 'Plan', exact: true });
  await expect(agreed.getByText('Approved with your changes')).toBeVisible();
  await expect(agreed.getByText('Say hello in Norwegian too')).toBeVisible();

  // The plan stays above the message box, as the user approved it.
  await w.getByRole('button', { name: /^Plan: Add a greeting/ }).click();
  const dialog = w.getByRole('dialog', { name: 'Plan' });
  await expect(dialog.getByText('Say hello in Norwegian too')).toBeVisible();
  await shot(w, 'session-plan');
});

test('what fills the context is shown, and a session that waits is listed under Needs you', async () => {
  const w = graft.window;
  provider.script({ text: 'Hi.' }, { toolCalls: [{ name: 'Write', input: { file_path: 'x.txt', content: 'x' } }] });
  const composer = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await composer.fill('hello');
  await composer.press('Enter');
  await expect(w.getByText('Hi.', { exact: true })).toBeVisible();

  // /context prints the parts and where the numbers come from, and asks no model.
  const box = w.getByRole('combobox', { name: SESSION_BOX }).or(w.getByRole('textbox', { name: SESSION_BOX }));
  await box.fill('/context');
  await box.press('Enter');
  await expect(w.getByText(/Context: about [\d,]+ of [\d,]+ tokens/)).toBeVisible();
  await expect(w.getByText(/System prompt: [\d,]+/)).toBeVisible();
  await expect(w.getByText(/Estimated from the text; the provider counted [\d,]+\./)).toBeVisible();
  expect(provider.chatRequests()).toHaveLength(1);

  // The same parts as bars, behind the context ring.
  await w.getByRole('button', { name: /^Context:/ }).click();
  await expect(w.getByText('What fills it')).toBeVisible();
  await expect(w.getByRole('img', { name: /^System prompt: .* tokens$/ })).toBeVisible();
  await expect(w.getByRole('img', { name: /^Built-in tools: .* tokens$/ })).toBeVisible();
  await shot(w, 'session-context');
  await w.keyboard.press('Escape');

  // A session that waits for an approval stays where it is while it is open: its card is on screen.
  const needsYou = w.getByRole('region', { name: 'Needs you' });
  await expect(needsYou).toHaveCount(0);
  await box.fill('write a file');
  await box.press('Enter');
  const card = w.getByRole('alertdialog');
  await expect(card).toBeVisible();
  await expect(needsYou).toHaveCount(0);

  // Look elsewhere and it is at the top of the sidebar; open it from there, answer, and it is back in its place.
  await w.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'New', exact: true }).click();
  const waiting = needsYou.getByRole('button', { name: /Scripted title/ }).first();
  await expect(waiting).toBeVisible();
  await shot(w, 'session-needs-you');
  await waiting.click();
  await expect(card).toBeVisible();
  await expect(needsYou).toHaveCount(0);
  await card.getByRole('button', { name: /Allow once/ }).click();
  await expect(w.getByText('Done.', { exact: true })).toBeVisible();
  await expect(needsYou).toHaveCount(0);
  await expect(w.getByRole('navigation', { name: 'Main' }).getByText('Scripted title', { exact: true })).toBeVisible();
});

test('a session is filed under a group and marked completed, and writing to it brings it back', async () => {
  const w = graft.window;
  provider.script({ text: 'First answer.' }, { text: 'Second answer.' });
  const composer = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await composer.fill('first task');
  await composer.press('Enter');
  await expect(w.getByText('First answer.', { exact: true })).toBeVisible();

  const sidebar = w.getByRole('navigation', { name: 'Main' });
  await expect(sidebar.getByText('Scripted title', { exact: true })).toBeVisible();

  // File it under a new group: the row leaves its project list for the group.
  await sidebar.getByRole('button', { name: 'Options for Scripted title' }).click();
  const move = w.getByRole('menuitem', { name: /^Move to group/ });
  await move.hover();
  await move.click();
  await w.getByRole('menuitem', { name: /^New group/ }).click();
  const create = w.getByRole('dialog', { name: 'New group' });
  await create.getByRole('textbox', { name: 'Name' }).fill('Work');
  await create.getByRole('button', { name: 'Create' }).click();

  const work = w.getByRole('region', { name: 'Work' });
  await expect(work.getByText('Scripted title', { exact: true })).toBeVisible();
  await shot(w, 'session-groups');

  // Mark as completed: the group empties and the session waits under Completed, folded shut.
  await work.getByRole('button', { name: 'Options for Scripted title' }).click();
  await w.getByRole('menuitem', { name: 'Mark as completed' }).click();
  await expect(w.getByRole('region', { name: 'Work' })).toHaveCount(0);
  const completed = w.getByRole('region', { name: 'Completed' });
  const fold = completed.getByRole('button', { name: /^Completed/ });
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
  await expect(completed.getByText('Scripted title', { exact: true })).toHaveCount(0);
  await shot(w, 'session-completed');
  await fold.click();
  await expect(completed.getByText('Scripted title', { exact: true })).toBeVisible();

  // Writing to it again marks it in progress: it returns to its group and Completed is gone.
  await completed.getByText('Scripted title', { exact: true }).click();
  const box = w.getByRole('textbox', { name: SESSION_BOX });
  await box.fill('one more look');
  await box.press('Enter');
  await expect(w.getByText('Second answer.', { exact: true })).toBeVisible();
  await expect(w.getByRole('region', { name: 'Completed' })).toHaveCount(0);
  await expect(work.getByText('Scripted title', { exact: true })).toBeVisible();

  // Rename the group from its header, then remove it: the session is kept and returns to its project.
  await work.getByRole('button', { name: 'Actions for Work' }).click();
  await w.getByRole('menuitem', { name: /^Rename/ }).click();
  const rename = w.getByRole('dialog', { name: /^Rename/ });
  await rename.getByRole('textbox', { name: 'Name' }).fill('Deep work');
  await rename.getByRole('button', { name: 'Rename' }).click();
  const renamed = w.getByRole('region', { name: 'Deep work' });
  await expect(renamed.getByText('Scripted title', { exact: true })).toBeVisible();

  await renamed.getByRole('button', { name: 'Actions for Deep work' }).click();
  await w.getByRole('menuitem', { name: /^Remove group/ }).click();
  await w.getByRole('dialog', { name: /Remove the group/ }).getByRole('button', { name: 'Remove group' }).click();
  await expect(w.getByRole('region', { name: 'Deep work' })).toHaveCount(0);
  await expect(sidebar.getByText('Scripted title', { exact: true })).toBeVisible();
});

test('find steps through matches with F3 and Shift+F3 from anywhere in the window', async () => {
  const w = graft.window;
  provider.script({ text: 'alpha graft, beta graft, gamma graft.' });
  const composer = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await composer.fill('start here');
  await composer.press('Enter');
  await expect(w.getByText('alpha graft, beta graft, gamma graft.')).toBeVisible();

  await w.keyboard.press('Control+f');
  const bar = w.getByRole('search', { name: 'Find in the conversation' });
  await bar.getByRole('textbox', { name: 'Find in the conversation' }).fill('graft');
  await expect(bar.getByText('1 of 3')).toBeVisible();

  // The bar is not where the key must be pressed: with the keyboard back in the message box, F3 steps on.
  const box = w.getByRole('textbox', { name: SESSION_BOX });
  await box.click();
  await w.keyboard.press('F3');
  await expect(bar.getByText('2 of 3')).toBeVisible();
  await w.keyboard.press('F3');
  await expect(bar.getByText('3 of 3')).toBeVisible();
  await w.keyboard.press('Shift+F3');
  await expect(bar.getByText('2 of 3')).toBeVisible();
  await shot(w, 'session-find-f3');

  // Escape closes the bar and nothing else.
  await w.keyboard.press('Escape');
  await expect(bar).toHaveCount(0);
});

test('a session opens beside the open one: two transcripts, one keyboard, and the split closes', async () => {
  const w = graft.window;
  provider.script({ text: 'First answer.' }, { text: 'Second answer.' });
  const composer = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await composer.fill('first task');
  await composer.press('Enter');
  await expect(w.getByText('First answer.', { exact: true })).toBeVisible();

  // A name of its own, so the two rows can be told apart (the scripted title is the same for both).
  const sidebar = w.getByRole('navigation', { name: 'Main' });
  await sidebar.getByRole('button', { name: 'Options for Scripted title' }).click();
  await w.getByRole('menuitem', { name: /^Rename/ }).click();
  const nameBox = w.getByRole('textbox', { name: 'Session title' });
  await nameBox.fill('First session');
  await nameBox.press('Enter');
  await expect(sidebar.getByText('First session', { exact: true })).toBeVisible();

  // A second session, then back to the first.
  await sidebar.getByRole('button', { name: 'New', exact: true }).click();
  const fresh = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await fresh.fill('second task');
  await fresh.press('Enter');
  await expect(w.getByText('Second answer.', { exact: true })).toBeVisible();
  await sidebar.getByText('First session', { exact: true }).click();
  await expect(w.getByText('First answer.', { exact: true })).toBeVisible();

  // Open the second beside the first: two transcripts, side by side.
  await sidebar.getByRole('button', { name: 'Options for Scripted title' }).click();
  await w.getByRole('menuitem', { name: 'Open beside' }).click();
  const logs = w.getByRole('log', { name: 'Conversation' });
  await expect(logs).toHaveCount(2);
  await expect(logs.filter({ hasText: 'First answer.' })).toHaveCount(1);
  await expect(logs.filter({ hasText: 'Second answer.' })).toHaveCount(1);
  await shot(w, 'session-split');

  // The session already open has nothing to open beside; Ctrl+F finds in the focused pane only.
  const first = w.getByRole('group', { name: 'Open session' });
  await first.getByRole('button', { name: 'First session' }).click();
  await expect(w.getByRole('menuitem', { name: 'Open beside' })).toHaveCount(0);
  await w.keyboard.press('Escape');
  await w.keyboard.press('Control+f');
  const bar = w.getByRole('search', { name: 'Find in the conversation' });
  await expect(bar).toHaveCount(1);
  await bar.getByRole('textbox', { name: 'Find in the conversation' }).fill('First answer');
  await expect(bar.getByText('1 of 1')).toBeVisible();
  await w.keyboard.press('Escape');

  // The conversation beside goes on the clipboard as Markdown, without a save dialog.
  const second = w.getByRole('group', { name: 'Session beside' });
  await second.getByRole('button', { name: 'More actions' }).click();
  await w.getByRole('menuitem', { name: 'Copy as Markdown' }).click();
  await expect(w.getByText('Conversation copied')).toBeVisible();
  await expect.poll(() => graft.app.evaluate(({ clipboard }) => clipboard.readText())).toContain('Second answer.');

  // Closing the split leaves the session that stays.
  await w.getByRole('button', { name: 'Close the split' }).click();
  await expect(logs).toHaveCount(1);
  await expect(w.getByRole('button', { name: 'Close the split' })).toHaveCount(0);
  await expect(w.getByText('First answer.', { exact: true })).toBeVisible();
});
