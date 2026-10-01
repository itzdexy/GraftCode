import fs from 'node:fs';
import path from 'node:path';
import { listPackage } from '@electron/asar';
import { expect, test } from '@playwright/test';
import { launchGraft, type LaunchedApp } from './support/launch';
import { MockProvider } from './support/mockProvider';
import { completeOnboarding, makeGitProject } from './support/onboard';

/**
 * Smoke test of the packaged app (electron-builder output). Runs only when
 * GRAFT_PACKAGED_EXE points at Graft.exe, e.g. after `npm run dist:win`:
 *   GRAFT_PACKAGED_EXE=dist/win-unpacked/Graft.exe npx playwright test packaged
 */
const exe = process.env.GRAFT_PACKAGED_EXE ? path.resolve(process.env.GRAFT_PACKAGED_EXE) : null;
const SHOTS = path.join(__dirname, '..', '..', 'test-results', 'shots');

test.skip(!exe, 'Set GRAFT_PACKAGED_EXE to the packaged Graft executable.');

let provider: MockProvider | undefined;
let graft: LaunchedApp | undefined;

test.afterEach(async () => {
  await graft?.close();
  await provider?.close();
});

test('the package holds only the built app and production dependencies (regression: sources and screenshots were packed)', () => {
  const asarPath = path.join(path.dirname(exe!), 'resources', 'app.asar');
  const top = new Set(listPackage(asarPath, { isPack: false }).map((entry) => entry.split(/[\\/]/).filter(Boolean)[0]));
  expect([...top].sort()).toEqual(['node_modules', 'out', 'package.json']);
  // Only this platform's native binaries are unpacked.
  const prebuilds = fs.readdirSync(path.join(path.dirname(exe!), 'resources', 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'prebuilds'));
  expect(prebuilds).toEqual([`${process.platform}-${process.arch}.node`]);
});

test('packaged app: onboarding, a session with native tools (SQLite, ripgrep, pty) and Settings', async () => {
  expect(exe && fs.existsSync(exe)).toBe(true);
  const mock = await MockProvider.start();
  provider = mock;
  const project = makeGitProject({ 'notes.txt': 'hello\n', 'src/app.ts': 'export const needle = 1;\n' });
  const app = await launchGraft({ executablePath: exe! });
  graft = app;
  const w = app.window;

  const info = await w.evaluate(async () => {
    const bridge = (window as unknown as { graft: { invoke(c: string): Promise<{ value: { version: string; isPackaged: boolean } }> } }).graft;
    return (await bridge.invoke('app:info')).value;
  });
  expect(info.isPackaged).toBe(true);
  expect(info.version).toBe('0.1.0');

  // Onboarding writes to SQLite and stores the provider.
  await completeOnboarding(app, mock, { project });

  // A session: Grep runs the bundled ripgrep, Edit (after a Read) waits for approval and applies.
  mock.script(
    { toolCalls: [{ name: 'Grep', input: { pattern: 'needle' } }, { name: 'Read', input: { file_path: 'notes.txt' } }] },
    { toolCalls: [{ name: 'Edit', input: { file_path: 'notes.txt', old_string: 'hello', new_string: 'hello from the installer' } }] },
    { text: 'Found it and updated the notes.' }
  );
  const composer = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await composer.fill('Find the needle and update the notes');
  await composer.press('Enter');
  const card = w.getByRole('alertdialog', { name: 'Edit notes.txt' });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: /Allow once/ }).click();
  await expect(w.getByText('Found it and updated the notes.')).toBeVisible();
  expect(fs.readFileSync(path.join(project, 'notes.txt'), 'utf8')).toBe('hello from the installer\n');
  // The Grep result that went back to the model came from the bundled ripgrep.
  const toolResults = JSON.stringify((mock.chatRequests()[1]!.body as { messages: unknown[] }).messages.slice(-2));
  expect(toolResults).toContain('src/app.ts');

  // The terminal panel starts a real shell through node-pty.
  await w.getByRole('button', { name: 'Terminal', exact: true }).click();
  const panel = w.getByRole('region', { name: 'Terminal' });
  await panel.locator('.xterm').click();
  await w.keyboard.type('echo packaged-$((6*7))');
  await w.keyboard.press('Enter');
  await expect(panel.locator('.xterm-rows')).toContainText(/packaged-(42|\$\(\(6\*7\)\))/);

  // Settings → About reports the update feed state for this build.
  await w.getByRole('button', { name: /^Account menu for/ }).click();
  await w.getByRole('menuitem', { name: 'Settings' }).click();
  await w.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name: 'About', exact: true }).click();
  await w.getByRole('switch', { name: 'Check for updates automatically' }).click();
  await expect(w.getByText('This build has no update feed configured.')).toBeVisible();
  fs.mkdirSync(SHOTS, { recursive: true });
  await w.screenshot({ path: path.join(SHOTS, 'packaged-about.png') });

  // Nothing was logged at error level.
  const logs = fs.readdirSync(path.join(app.userData, 'logs')).map((f) => fs.readFileSync(path.join(app.userData, 'logs', f), 'utf8')).join('\n');
  expect(logs).not.toMatch(/\bERROR\b/);
});
