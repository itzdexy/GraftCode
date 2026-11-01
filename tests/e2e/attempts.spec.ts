import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchGraft, type LaunchedApp } from './support/launch';
import { MockProvider, requestText } from './support/mockProvider';
import { completeOnboarding, makeGitProject } from './support/onboard';

let graft: LaunchedApp | undefined;
let provider: MockProvider | undefined;
test.afterEach(async () => {
  await graft?.close();
  await provider?.close();
});

/** Whether a chat request already carries a tool's result: the attempt wrote its file and now reports. */
const answered = (body: unknown): boolean => ((body as { messages?: Array<{ role: string }> }).messages ?? []).some((m) => m.role === 'tool');

/** Each attempt writes result.txt with its own words; its prompt says which attempt it is. */
function scriptAttempts(mock: MockProvider, of: number): void {
  for (let n = 1; n <= of; n++) {
    const mine = (body: unknown): boolean => requestText(body).includes(`# Attempt ${String(n)} of ${String(of)}`);
    mock.answer((body) => mine(body) && !answered(body), { toolCalls: [{ name: 'Write', input: { file_path: 'result.txt', content: `from attempt ${String(n)}\n` } }] });
    mock.answer((body) => mine(body) && answered(body), { text: `Attempt ${String(n)} wrote result.txt.` });
  }
}

/** The private checkouts on record: where each is, by its record in Graft's home. */
function checkouts(home: string): string[] {
  const dir = path.join(home, 'agent-workspaces');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => (JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as { info: { path: string } }).info.path);
}

async function chooseMode(w: Page, mode: RegExp): Promise<void> {
  await w.getByRole('button', { name: /Permission mode/ }).click();
  await w.getByRole('menuitem', { name: mode }).click();
}

test('a message sent as two attempts on two models: both finish in their checkouts, the card compares them, and the one applied is what the folder gets', async () => {
  const project = makeGitProject({ 'notes.txt': 'hello\n' });
  provider = await MockProvider.start();
  graft = await launchGraft();
  await completeOnboarding(graft, provider, { project });
  scriptAttempts(provider, 2);
  const w = graft.window;
  await chooseMode(w, /Auto-edit/);
  // Code home sends as attempts once it knows the folder: until then the control says why it is off.
  await expect(w.getByRole('button', { name: 'Attempts: off. Attempts work in a session with a project folder.' })).toBeVisible();
  await w.getByRole('button', { name: 'Choose folder' }).click();
  await w.getByRole('menuitem', { name: path.basename(project) }).click();

  // Two attempts, the second on the other model.
  await w.getByRole('button', { name: 'Attempts: off', exact: true }).click();
  const choice = w.getByRole('dialog', { name: 'Send as attempts' });
  await choice.getByRole('radio', { name: '2' }).click();
  await choice.getByRole('button', { name: 'Model for attempt 2: Graft Test Large' }).click();
  await w.getByRole('menuitem', { name: 'Graft Test Mini' }).click();
  await expect(choice.getByRole('button', { name: 'Model for attempt 2: Graft Test Mini' })).toBeVisible();
  await w.keyboard.press('Escape');
  await expect(w.getByRole('button', { name: 'Attempts: 2', exact: true })).toBeVisible();
  const box = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await box.fill('Write result.txt');
  await box.press('Enter');

  const card = w.getByRole('region', { name: 'Attempts' });
  await expect(card.getByText('2 attempts · 2 ready to compare')).toBeVisible({ timeout: 30_000 });
  await expect(card.getByRole('listitem', { name: 'Attempt 1, Graft Test Large: Done' })).toBeVisible();
  await expect(card.getByRole('listitem', { name: 'Attempt 2, Graft Test Mini: Done' })).toBeVisible();
  // The choice went with the message: the session's own box sends once.
  await expect(w.getByRole('button', { name: 'Attempts: off', exact: true })).toBeVisible();
  await expect(card.getByText('No checks ran: this project has none set up. Add them in Customize → Checks.')).toHaveCount(1);
  await w.screenshot({ path: test.info().outputPath('attempts-ready.png') });
  // Nothing reached the folder yet; each attempt has its own checkout.
  expect(fs.existsSync(path.join(project, 'result.txt'))).toBe(false);
  const before = checkouts(graft.graftHome);
  expect(before).toHaveLength(2);
  for (const dir of before) expect(fs.existsSync(dir)).toBe(true);

  for (const n of [1, 2]) {
    await card.getByRole('button', { name: `View diff of attempt ${String(n)}` }).click();
    const diff = w.getByRole('dialog', { name: new RegExp(`^Attempt ${String(n)} · `) });
    await expect(diff).toContainText('result.txt');
    await expect(diff).toContainText(`from attempt ${String(n)}`);
    await w.keyboard.press('Escape');
    await expect(diff).toBeHidden();
  }

  await card.getByRole('button', { name: 'Apply attempt 2' }).click();
  await expect(card.getByText('Applied attempt 2 of 2')).toBeVisible();
  expect(fs.readFileSync(path.join(project, 'result.txt'), 'utf8')).toBe('from attempt 2\n');
  for (const dir of before) expect(fs.existsSync(dir)).toBe(false);
  // The conversation says which attempt went in, for the next turn to read.
  await expect(w.getByText('Applied attempt 2 of 2 (Graft Test Mini) to the folder. It changed result.txt.')).toBeVisible();
  await w.screenshot({ path: test.info().outputPath('attempts-applied.png') });
});

test('in Ask mode each approval card says which attempt asks, and Discard all removes every checkout and leaves the folder alone', async () => {
  const project = makeGitProject({ 'notes.txt': 'hello\n' });
  provider = await MockProvider.start();
  graft = await launchGraft();
  await completeOnboarding(graft, provider, { project });
  scriptAttempts(provider, 2);
  provider.script({ text: 'Hello. What should I write?' });
  const w = graft.window;
  await chooseMode(w, /^Ask/);
  // A session first, from a message sent once; its own box then sends the next as attempts.
  const home = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await home.fill('Hello');
  await home.press('Enter');
  await expect(w.getByText('Hello. What should I write?')).toBeVisible({ timeout: 30_000 });

  await w.getByRole('button', { name: 'Attempts: off', exact: true }).click();
  await w.getByRole('dialog', { name: 'Send as attempts' }).getByRole('radio', { name: '2' }).click();
  await w.keyboard.press('Escape');
  const box = w.getByRole('textbox', { name: /^Ask anything/ });
  await box.fill('Write result.txt');
  await box.press('Enter');

  // The two attempts ask one after the other, each by name.
  const asked: string[] = [];
  for (let i = 0; i < 2; i++) {
    const approval = w.getByRole('alertdialog');
    await expect(approval).toContainText(/Attempt [12] · Graft Test Large/, { timeout: 30_000 });
    const n = /Attempt ([12])/.exec((await approval.textContent()) ?? '')?.[1] ?? '';
    asked.push(n);
    await approval.getByRole('button', { name: /Allow once/ }).click();
    // The other attempt's card can take its place at once.
    await expect(w.getByRole('alertdialog').filter({ hasText: `Attempt ${n} ·` })).toHaveCount(0);
  }
  expect(asked.sort()).toEqual(['1', '2']);

  const card = w.getByRole('region', { name: 'Attempts' });
  await expect(card.getByText('2 attempts · 2 ready to compare')).toBeVisible({ timeout: 30_000 });
  const before = checkouts(graft.graftHome);
  expect(before).toHaveLength(2);
  await card.getByRole('button', { name: 'Discard all' }).click();
  await expect(card.getByText('2 attempts, discarded')).toBeVisible();
  for (const dir of before) expect(fs.existsSync(dir)).toBe(false);
  expect(checkouts(graft.graftHome)).toEqual([]);
  expect(fs.existsSync(path.join(project, 'result.txt'))).toBe(false);
});
