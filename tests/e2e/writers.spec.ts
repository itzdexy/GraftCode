import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchGraft, type LaunchedApp } from './support/launch';
import { MockProvider } from './support/mockProvider';
import { completeOnboarding, makeGitProject } from './support/onboard';

let graft: LaunchedApp | undefined;
let provider: MockProvider | undefined;
test.afterEach(async () => { await graft?.close(); await provider?.close(); });

test('parallel writers use private checkouts and expose integrated patches that survive reload', async () => {
  const project = makeGitProject({ 'a.txt': 'before a\n', 'b.txt': 'before b\n' });
  provider = await MockProvider.start(); graft = await launchGraft();
  await completeOnboarding(graft, provider, { project });
  const steps = new Map<string, number>();
  provider.respondToChat = (body) => {
    const request = body as { messages: Array<{ role: string; content: string }> };
    const system = request.messages.find((m) => m.role === 'system')?.content ?? '';
    const task = /Your task: "Write ([ab])"/.exec(system)?.[1];
    const key = task ?? 'main'; const step = steps.get(key) ?? 0; steps.set(key, step + 1);
    if (!task) return step === 0 ? { toolCalls: [{ name: 'RunAgents', input: { goal: 'Write two independent files', agents: [
      { id: 'a', role: 'implementer', task: 'Write a', prompt: 'Change a.txt to after a.', writes: ['a.txt'] },
      { id: 'b', role: 'implementer', task: 'Write b', prompt: 'Change b.txt to after b.', writes: ['b.txt'] }
    ] } }] } : { text: 'Both private writers integrated.' };
    if (step === 0) return { toolCalls: [{ name: 'Read', input: { file_path: `${task}.txt` } }] };
    if (step === 1) return { toolCalls: [{ name: 'Edit', input: { file_path: `${task}.txt`, old_string: `before ${task}`, new_string: `after ${task}` } }] };
    return { text: `Writer ${task} completed.`, chunkDelayMs: 20 };
  };
  const w = graft.window;
  await w.getByRole('button', { name: /Permission mode/ }).click();
  await w.getByRole('menuitem', { name: /Auto-edit/ }).click();
  await w.getByRole('textbox', { name: 'Describe a task or ask a question' }).fill('Run two independent writers');
  await w.getByRole('textbox', { name: 'Describe a task or ask a question' }).press('Enter');
  await expect(w.getByText('Both private writers integrated.', { exact: true })).toBeVisible({ timeout: 30000 });
  expect(fs.readFileSync(path.join(project, 'a.txt'), 'utf8')).toBe('after a\n');
  expect(fs.readFileSync(path.join(project, 'b.txt'), 'utf8')).toBe('after b\n');
  const panel = w.getByRole('region', { name: 'Agents', exact: true });
  await panel.getByRole('button', { name: /^Write a: Implementer, done/ }).click();
  await expect(panel.getByText('Changes integrated', { exact: true })).toBeVisible();
  const manifests = fs.readdirSync(path.join(graft.graftHome, 'agent-workspaces')).filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(graft!.graftHome, 'agent-workspaces', name), 'utf8')) as { info: { state: string; path: string; patchPath: string } });
  expect(manifests).toHaveLength(2);
  expect(new Set(manifests.map((m) => m.info.path)).size).toBe(2);
  for (const manifest of manifests) { expect(manifest.info.state).toBe('integrated'); expect(fs.existsSync(manifest.info.patchPath)).toBe(true); }
  await w.reload();
  await w.getByRole('navigation', { name: 'Main' }).getByText('Scripted title', { exact: true }).click();
  await w.getByRole('button', { name: 'Agents', exact: true }).click();
  await w.getByRole('region', { name: 'Agents', exact: true }).getByRole('button', { name: /^Write a: Implementer, done/ }).click();
  await expect(w.getByText('Changes integrated', { exact: true })).toBeVisible();
  await w.screenshot({ path: test.info().outputPath('private-writers.png') });
});

test('a destination edit becomes a visible recoverable writer conflict instead of overwriting the user', async () => {
  const project = makeGitProject({ 'a.txt': 'before a\n' });
  provider = await MockProvider.start(); graft = await launchGraft();
  await completeOnboarding(graft, provider, { project });
  let mainStep = 0; let writerStep = 0;
  provider.respondToChat = (body) => {
    const request = body as { messages: Array<{ role: string; content: string }> };
    const system = request.messages.find((m) => m.role === 'system')?.content ?? '';
    if (!system.includes('Your task: "Write a"')) return mainStep++ === 0 ? { toolCalls: [{ name: 'RunAgents', input: {
      goal: 'Preserve destination conflicts', agents: [{ id: 'a', role: 'implementer', task: 'Write a', prompt: 'Change a.txt.', writes: ['a.txt'] }]
    } }] } : { text: 'The private writer needs conflict review.' };
    if (writerStep++ === 0) return { toolCalls: [{ name: 'Read', input: { file_path: 'a.txt' } }] };
    if (writerStep === 2) return { toolCalls: [{ name: 'Edit', input: { file_path: 'a.txt', old_string: 'before a', new_string: 'after a' } }] };
    fs.writeFileSync(path.join(project, 'a.txt'), 'user change\n');
    return { text: 'The writer changed a.txt.' };
  };
  const w = graft.window;
  await w.getByRole('button', { name: /Permission mode/ }).click();
  await w.getByRole('menuitem', { name: /Auto-edit/ }).click();
  const composer = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await composer.fill('Run a writer with conflict recovery'); await composer.press('Enter');
  await expect(w.getByText('The private writer needs conflict review.', { exact: true })).toBeVisible({ timeout: 30000 });
  expect(fs.readFileSync(path.join(project, 'a.txt'), 'utf8')).toBe('user change\n');
  const panel = w.getByRole('region', { name: 'Agents', exact: true });
  await panel.getByRole('button', { name: /^Write a: Implementer, failed/ }).click();
  await expect(panel.getByText('Retained for review', { exact: true })).toBeVisible();
  const directory = path.join(graft.graftHome, 'agent-workspaces');
  const name = fs.readdirSync(directory).find((n) => n.endsWith('.json'))!;
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')) as { info: { state: string; path: string; patchPath: string } };
  expect(manifest.info.state).toBe('retained');
  expect(fs.readFileSync(path.join(manifest.info.path, 'a.txt'), 'utf8')).toBe('after a\n');
  expect(fs.readFileSync(manifest.info.patchPath, 'utf8')).toContain('+after a');
});

test('the Task tool isolates a general delegated writer and integrates its checked file revision', async () => {
  const project = makeGitProject({ 'a.txt': 'before a\n' });
  provider = await MockProvider.start(); graft = await launchGraft();
  await completeOnboarding(graft, provider, { project });
  let mainStep = 0; let writerStep = 0;
  provider.respondToChat = (body) => {
    const request = body as { messages: Array<{ role: string; content: string }> };
    const system = request.messages.find((m) => m.role === 'system')?.content ?? '';
    if (!system.includes('# Delegated task')) return mainStep++ === 0 ? { toolCalls: [{ name: 'Task', input: {
      description: 'Edit the delegated file', prompt: 'Read a.txt then replace before a with after a.', subagent_type: 'general'
    } }] } : { text: 'The delegated patch is integrated.' };
    if (writerStep++ === 0) return { toolCalls: [{ name: 'Read', input: { file_path: 'a.txt' } }] };
    if (writerStep === 2) return { toolCalls: [{ name: 'Edit', input: { file_path: 'a.txt', old_string: 'before a', new_string: 'after a' } }] };
    return { text: 'The delegated file is edited.' };
  };
  const w = graft.window;
  await w.getByRole('button', { name: /Permission mode/ }).click();
  await w.getByRole('menuitem', { name: /Auto-edit/ }).click();
  const composer = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await composer.fill('Delegate an edit'); await composer.press('Enter');
  await expect(w.getByText('The delegated patch is integrated.', { exact: true })).toBeVisible({ timeout: 30000 });
  expect(fs.readFileSync(path.join(project, 'a.txt'), 'utf8')).toBe('after a\n');
  const directory = path.join(graft.graftHome, 'agent-workspaces');
  const name = fs.readdirSync(directory).find((n) => n.endsWith('.json'))!;
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')) as { info: { state: string } };
  expect(manifest.info.state).toBe('integrated');
});
