import { expect, test } from '@playwright/test';
import { launchGraft, type LaunchedApp } from './support/launch';
import { MockProvider } from './support/mockProvider';
import { completeOnboarding, makeGitProject } from './support/onboard';

let graft: LaunchedApp | undefined;
let provider: MockProvider | undefined;
test.afterEach(async () => { await graft?.close(); await provider?.close(); });

test('a trusted code session exposes real semantic definitions and current type errors to its agent', async () => {
  const project = makeGitProject({
    'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022' } }),
    'library.ts': 'export function twice(value: number): number { return value * 2; }\n',
    'main.ts': 'import { twice as double } from "./library";\nexport const answer = double("wrong");\n'
  });
  provider = await MockProvider.start(); graft = await launchGraft();
  await completeOnboarding(graft, provider, { project });
  await graft.window.evaluate(async (folder) => {
    const bridge = (window as unknown as { graft: { invoke(channel: string, input?: unknown): Promise<{ ok: boolean; value: Array<{ id: string; path: string }> }> } }).graft;
    const projects = (await bridge.invoke('projects:list')).value;
    const selected = projects.find((p) => p.path === folder);
    if (!selected || !(await bridge.invoke('projects:update', { id: selected.id, trusted: true })).ok) throw new Error('Could not trust semantic fixture project');
  }, project);
  provider.script({ toolCalls: [
    { name: 'SemanticCode', input: { action: 'definition', file: 'main.ts', line: 2, column: 23 } },
    { name: 'SemanticCode', input: { action: 'diagnostics', file: 'main.ts' } }
  ] }, { text: 'The semantic server resolved the imported function and detected the type mismatch.' });
  const composer = graft.window.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await composer.fill('Resolve this imported function and inspect its current type errors'); await composer.press('Enter');
  await expect(graft.window.getByText('The semantic server resolved the imported function and detected the type mismatch.')).toBeVisible();
  const messages = JSON.stringify((provider.chatRequests()[1]?.body as { messages: unknown[] }).messages.slice(-2));
  expect(messages).toContain('typescript-language-server');
  expect(messages).toContain('library.ts');
  expect(messages).toContain('2345');
});
