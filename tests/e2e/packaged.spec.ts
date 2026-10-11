import fs from 'node:fs';
import path from 'node:path';
import { listPackage } from '@electron/asar';
import { expect, test } from '@playwright/test';
import { launchGraft, makeTempDir, type LaunchedApp } from './support/launch';
import { MockProvider } from './support/mockProvider';
import { completeOnboarding, makeGitProject } from './support/onboard';

/**
 * Smoke test of the packaged app (electron-builder output). Runs only when
 * GRAFT_PACKAGED_EXE points at the packaged executable, e.g. after `npm run dist:win`:
 *   GRAFT_PACKAGED_EXE=dist/win-unpacked/Graft.exe npx playwright test packaged
 * (macOS: dist/mac-arm64/Graft.app/Contents/MacOS/Graft, Linux: dist/linux-unpacked/graft).
 */
const exe = process.env.GRAFT_PACKAGED_EXE ? path.resolve(process.env.GRAFT_PACKAGED_EXE) : null;
const SHOTS = path.join(__dirname, '..', '..', 'test-results', 'shots');

test.skip(!exe, 'Set GRAFT_PACKAGED_EXE to the packaged Graft executable.');

/** The packaged resources folder: next to the executable, or Contents/Resources in a macOS bundle. */
function resourcesDir(executable: string): string {
  return process.platform === 'darwin' ? path.join(path.dirname(executable), '..', 'Resources') : path.join(path.dirname(executable), 'resources');
}

let provider: MockProvider | undefined;
let graft: LaunchedApp | undefined;

test.afterEach(async () => {
  await graft?.close();
  await provider?.close();
});

test('the package holds only the built app and production dependencies (regression: sources and screenshots were packed)', () => {
  const resources = resourcesDir(exe!);
  const top = new Set(listPackage(path.join(resources, 'app.asar'), { isPack: false }).map((entry) => entry.split(/[\\/]/).filter(Boolean)[0]));
  expect([...top].sort()).toEqual(['node_modules', 'out', 'package.json']);
  // Only this platform's native binaries are unpacked (Windows ships x64 only; macOS and Linux keep both architectures).
  const prebuilds = fs.readdirSync(path.join(resources, 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'prebuilds'));
  if (process.platform === 'win32') expect(prebuilds).toEqual(['win32-x64.node']);
  else {
    expect(prebuilds).toContain(`${process.platform}-${process.arch}.node`);
    expect(prebuilds.filter((name) => !name.startsWith(process.platform === 'linux' ? 'linux' : process.platform))).toEqual([]);
  }
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
  const { version } = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8')) as { version: string };
  expect(info.version).toBe(version);

  // Onboarding writes to SQLite and stores the provider.
  await completeOnboarding(app, mock, { project });
  await w.evaluate(async (folder) => {
    const bridge = (window as unknown as { graft: { invoke(channel: string, input?: unknown): Promise<{ ok: boolean; value: Array<{ id: string; path: string }> }> } }).graft;
    const projects = (await bridge.invoke('projects:list')).value;
    const selected = projects.find((p) => p.path === folder);
    if (!selected || !(await bridge.invoke('projects:update', { id: selected.id, trusted: true })).ok) throw new Error('Could not trust packaged semantic fixture');
  }, project);

  // A session: Grep runs the bundled ripgrep, Edit (after a Read) waits for approval and applies.
  mock.script(
    { toolCalls: [{ name: 'Grep', input: { pattern: 'needle' } }, { name: 'Read', input: { file_path: 'notes.txt' } },
      { name: 'SemanticCode', input: { action: 'outline', file: 'src/app.ts' } }] },
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
  expect(toolResults).toContain('typescript-language-server');
  expect(toolResults).toContain('needle');

  // The editor and its worker load from the package and save through the native bridge.
  await w.getByRole('button', { name: 'More actions' }).click();
  await w.getByRole('menuitem', { name: /^Files/ }).click();
  await w.getByRole('tree', { name: 'Files' }).getByRole('button', { name: /^notes.txt/ }).first().click();
  await w.getByRole('button', { name: 'Edit file', exact: true }).click();
  await w.getByRole('textbox', { name: 'Edit notes.txt' }).focus();
  await w.keyboard.press('Control+A'); await w.keyboard.type('packaged editor'); await w.keyboard.press('Control+S');
  await expect.poll(() => fs.readFileSync(path.join(project, 'notes.txt'), 'utf8')).toBe('packaged editor');
  await w.keyboard.press('Control+Shift+F');

  // The terminal panel starts a real shell through node-pty.
  await w.getByRole('button', { name: 'Terminal', exact: true }).click();
  const panel = w.getByRole('region', { name: 'Terminal' });
  await panel.locator('.xterm').click();
  await w.keyboard.type('echo packaged-$((6*7))');
  await w.keyboard.press('Enter');
  await expect(panel.locator('.xterm-rows')).toContainText(/packaged-(42|\$\(\(6\*7\)\))/);

  // Settings → About: the build reads updates from the release feed, and turning updates off stops the checks.
  await w.getByRole('button', { name: /^Account menu for/ }).click();
  await w.getByRole('menuitem', { name: 'Settings' }).click();
  await w.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name: 'About', exact: true }).click();
  expect(fs.existsSync(path.join(resourcesDir(exe!), 'app-update.yml'))).toBe(true);
  const updates = w.getByRole('switch', { name: 'Check for updates automatically' });
  await expect(updates).toBeChecked();
  await expect(w.getByRole('button', { name: /^(Check for updates|Checking…)$/ })).toBeVisible();
  await expect(w.getByText('This build has no update feed configured.')).toHaveCount(0);
  await updates.click();
  await expect(w.getByText('Automatic updates are off.')).toBeVisible();
  fs.mkdirSync(SHOTS, { recursive: true });
  await w.screenshot({ path: path.join(SHOTS, 'packaged-about.png') });

  // Nothing was logged at error level.
  const logs = fs.readdirSync(path.join(app.userData, 'logs')).map((f) => fs.readFileSync(path.join(app.userData, 'logs', f), 'utf8')).join('\n');
  expect(logs).not.toMatch(/\bERROR\b/);
});

test('packaged app: the skill and the fonts in the package draw a diagram, and its picture is saved', async () => {
  expect(exe && fs.existsSync(exe)).toBe(true);
  const resources = resourcesDir(exe!);
  const skill = path.join(resources, 'skills', 'diagram-design');
  expect(fs.existsSync(path.join(skill, 'SKILL.md'))).toBe(true);
  expect(fs.readdirSync(path.join(resources, 'fonts')).sort()).toEqual(['Geist.woff2', 'GeistMono.woff2', 'InstrumentSerif-Italic.woff2', 'InstrumentSerif-Regular.woff2', 'OFL.txt']);

  const mock = await MockProvider.start();
  provider = mock;
  const project = makeGitProject();
  const app = await launchGraft({ executablePath: exe! });
  graft = app;
  const w = app.window;
  await completeOnboarding(app, mock, { project });

  // A diagram as the skill writes one, from the template in the package.
  const page = fs
    .readFileSync(path.join(skill, 'assets', 'template.html'), 'utf8')
    .replaceAll('[diagram-slug]', 'orders')
    .replaceAll('[Diagram title]', 'Orders')
    .replace('<!-- Draw arrows first, then nodes. Replace with your content. -->', '<rect x="80" y="80" width="240" height="120" rx="6" fill="#ffffff" stroke="#2d3142"/>');
  mock.script({ toolCalls: [{ name: 'Write', input: { file_path: 'docs/diagrams/orders.html', content: page } }] }, { text: 'Saved the diagram.' });
  const composer = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await composer.fill('/diagram how an order is paid');
  await composer.press('Enter');
  await w.getByRole('alertdialog').getByRole('button', { name: /Allow once/ }).click();
  await expect(w.getByText('Saved the diagram.')).toBeVisible();
  // The session was told about the skill, which only a skill found in the package is.
  expect(JSON.stringify(mock.chatRequests()[0]?.body)).toContain("Graft's copy of this skill is read-only");

  // The page is drawn with the fonts from the package.
  const card = w.getByRole('region', { name: 'Diagrams from this turn' });
  const inner = card.frameLocator('iframe[title="Diagram: Orders"]');
  await expect(inner.locator('style[data-graft-fonts]')).toHaveCount(1);
  const loaded = await inner.locator('svg[role="img"]').evaluate(async () => {
    await document.fonts.ready;
    const families: string[] = [];
    document.fonts.forEach((face) => {
      if (face.status === 'loaded') families.push(face.family.replace(/['"]/g, ''));
    });
    return families;
  });
  expect(loaded).toEqual(expect.arrayContaining(['Instrument Serif', 'Geist Mono']));

  // The picture comes from the package's own hidden window, at twice the diagram's size.
  const target = path.join(makeTempDir('graft-packaged-diagram-'), 'orders.png');
  await app.app.evaluate(({ dialog }, chosen) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: chosen });
  }, target);
  await card.getByRole('button', { name: 'Save as…' }).click();
  await w.getByRole('menuitem', { name: 'PNG image' }).click();
  await expect.poll(() => fs.existsSync(target), { timeout: 30_000 }).toBe(true);
  const png = fs.readFileSync(target);
  expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1920, 1200]);
  fs.mkdirSync(SHOTS, { recursive: true });
  await w.screenshot({ path: path.join(SHOTS, 'packaged-diagram.png') });
});
