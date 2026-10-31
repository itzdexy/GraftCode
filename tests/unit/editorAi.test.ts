import { describe, expect, it } from 'vitest';
import { GraftError } from '../../src/shared/errors';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '../../src/shared/schemas/appSettings';
import type { SessionSummary } from '../../src/shared/schemas/sessions';
import { maskSecrets } from '../../src/shared/secrets';
import {
  AFTER_CHARS,
  BEFORE_CHARS,
  cleanCompletion,
  cleanReplacement,
  completionInput,
  COVER,
  CURSOR,
  editInput,
  maskParts,
  windowAfter,
  windowBefore
} from '../../src/main/editor/completions';
import { EditorAi } from '../../src/main/editor/editorAi';
import { FakeProvider, fakeModel, type FakeStep } from '../support/fakeProvider';

// Made up, in the shape of a real key; never issued.
const KEY = `sk-ant-api03-${'a1B2c3D4'.repeat(6)}`;

describe('the code a suggestion is written from', () => {
  it('keeps about 6,000 characters before the cursor and 2,000 after, cut where lines begin and end', () => {
    const lines = Array.from({ length: 2_000 }, (_, i) => `line ${i};`).join('\n');
    const before = windowBefore(`${lines}\ncurrent`);
    expect(before.length).toBeLessThanOrEqual(BEFORE_CHARS);
    expect(before.startsWith('line ')).toBe(true);
    expect(before.endsWith('\ncurrent')).toBe(true);
    const after = windowAfter(` rest\n${lines}`);
    expect(after.length).toBeLessThanOrEqual(AFTER_CHARS);
    expect(after.startsWith(' rest\n')).toBe(true);
    expect(after.endsWith(';')).toBe(true);
    // Short texts and one long line are kept as they are, or cut where they must be.
    expect(windowBefore('short')).toBe('short');
    expect(windowBefore('x'.repeat(7_000))).toHaveLength(BEFORE_CHARS);
  });

  it('covers a key on both sides of the cursor, as one text would have it', () => {
    const half = Math.floor(KEY.length / 2);
    const [before = '', after = ''] = maskParts([`const key = "${KEY.slice(0, half)}`, `${KEY.slice(half)}";\n`]);
    expect(before).not.toContain(KEY.slice(10, half));
    expect(after).not.toContain(KEY.slice(half));
    expect(before).toContain(COVER);
    expect(after.startsWith(COVER)).toBe(true);
    expect(maskParts([`token ${KEY} end`])).toEqual([maskSecrets(`token ${KEY} end`)]);
    expect(maskParts(['plain ', 'code'])).toEqual(['plain ', 'code']);
  });

  it('names the file and its language and marks the cursor', () => {
    expect(completionInput('src/a.ts', 'typescript', 'const a = ', ';')).toBe(`File: src/a.ts\nLanguage: typescript\n\nconst a = ${CURSOR};`);
  });
});

describe('what is kept of a suggestion', () => {
  it('takes the code out of a fenced block', () => {
    expect(cleanCompletion('```ts\nreturn x;\n```', 'function f() {\n  ', '\n}')).toBe('return x;');
    expect(cleanCompletion('Here it is:\n```\nreturn x;```', '  ', '')).toBe('return x;');
  });

  it('drops what the model repeats of the text before the cursor', () => {
    expect(cleanCompletion('items.reduce((a, b) => a + b, 0);', '  const total = items.red', '')).toBe('uce((a, b) => a + b, 0);');
    expect(cleanCompletion('  return a + 1;', 'function f(a) {\n  return a', '\n}')).toBe(' + 1;');
    expect(cleanCompletion('function add(a, b) {\n  return a + b;\n}', 'function add(a, b) {\n  return a', '')).toBe(' + b;');
    expect(cleanCompletion(`const a = ${CURSOR}1;`, 'const a = ', '')).toBe('1;');
    // A word that only happens to end like the line is not taken for a repeat.
    expect(cleanCompletion('a + 1;', 'const x = a', '')).toBe('a + 1;');
  });

  it('drops what already follows the cursor, unless the brackets say it is needed', () => {
    expect(cleanCompletion('bar);', 'foo(', ');\nnext();')).toBe('bar');
    expect(cleanCompletion('x)', 'foo(bar(', ')\n')).toBe('x)');
    expect(cleanCompletion('  return 1;\n}', 'function f() {\n', '}\n')).toBe('  return 1;');
    // A closing line indented like a block of its own is the suggestion's, not the one below.
    expect(cleanCompletion('if (x) {\n    y();\n  }', 'function f() {\n  ', '\n}')).toBe('if (x) {\n    y();\n  }');
  });

  it('ends where the line or the block ends', () => {
    expect(cleanCompletion('b();\n}\nmore();', 'if (a) {\n  ', '\n}')).toBe('b();');
    expect(cleanCompletion('const a = 1;\n\nconst b = 2;', '', '')).toBe('const a = 1;');
    expect(cleanCompletion(' 42.\nAnd more prose.', 'The answer is', '')).toBe(' 42.');
    expect(cleanCompletion('\n    return x * 2\n\ndef g(x):\n    pass', 'def double(x):', '')).toBe('\n    return x * 2');
    expect(cleanCompletion(Array.from({ length: 30 }, (_, i) => `step${i}();`).join('\n'), '', '').split('\n')).toHaveLength(16);
    expect(cleanCompletion('x'.repeat(5_000), 'const s = "', '').length).toBeLessThanOrEqual(1_200);
  });

  it('is empty when nothing useful is left, and never writes a covered secret', () => {
    expect(cleanCompletion('   \n\n', 'a', '')).toBe('');
    expect(cleanCompletion('```\n```', 'a', '')).toBe('');
    expect(cleanCompletion(');', 'foo(', ');')).toBe('');
    expect(cleanCompletion(`"${COVER}";`, 'const key = ', '')).toBe('');
    expect(cleanCompletion('x = 1;   \n', '', '')).toBe('x = 1;');
  });
});

describe('the new text for the selected lines', () => {
  it('takes the code out of fences and tags and keeps the selection indented', () => {
    expect(cleanReplacement('```js\nreturn a + b;\n```', '    return a+b;')).toBe('    return a + b;');
    expect(cleanReplacement('<selection>\n  one();\n  two();\n</selection>', '  one();')).toBe('  one();\n  two();');
    expect(cleanReplacement('\n\nif (a) {\n  b();\n}\n', '\tif(a) b();')).toBe('\tif (a) {\n\t  b();\n\t}');
    expect(cleanReplacement('FIRST LINE\nSECOND LINE\n', 'first line\nsecond line')).toBe('FIRST LINE\nSECOND LINE');
    expect(cleanReplacement('   ', 'x')).toBe('');
  });

  it('asks for a change to the proposal when one is refined', () => {
    const first = editInput({ file: 'a.ts', language: 'typescript', before: 'b', selection: 's', after: 'a', instruction: 'Shout it' });
    expect(first).toContain('<selection>\ns\n</selection>');
    expect(first).not.toContain('<proposal>');
    expect(editInput({ file: 'a.ts', language: 'typescript', before: 'b', selection: 's', after: 'a', instruction: 'shorter', proposal: 'S' })).toContain('<proposal>\nS\n</proposal>\n\nInstruction: shorter');
  });
});

const MAIN = fakeModel();
const FAST = fakeModel({ ref: { providerId: 'fake', modelId: 'fast-mini' }, label: 'Fast Mini', cheap: true });

function service(script: FakeStep[], options: { settings?: Partial<AppSettings>; kind?: 'code' | 'chat' } = {}) {
  const provider = new FakeProvider(script, [MAIN, FAST]);
  const settings: AppSettings = { ...DEFAULT_APP_SETTINGS, ...options.settings };
  const summary = { kind: options.kind ?? 'code', model: MAIN.ref } as SessionSummary;
  const ai = new EditorAi({ settings: () => settings, session: () => summary, models: () => provider.listModels(), provider: () => provider });
  return { ai, provider };
}

const ASK = { sessionId: 's1', file: 'src/app.ts', language: 'typescript', prefix: 'const answer = ', suffix: ';\n' };

describe('the editor AI in the main process', () => {
  it('asks the fast model of the session’s provider, as the Privacy setting says', async () => {
    const { ai, provider } = service([{ text: '42;' }]);
    expect(await ai.complete({ ...ASK, requestId: 'r1' })).toEqual({ text: '42' });
    const request = provider.requests[0]!;
    expect(request.model.ref.modelId).toBe('fast-mini');
    expect(request.privacy).toEqual({ noTraining: true, zeroRetention: false });
    expect(request.tools).toEqual([]);
    const sent = JSON.stringify(request.messages);
    expect(sent).toContain('File: src/app.ts');
    expect(sent).toContain(`const answer = ${CURSOR};`);
    expect(await ai.model('s1', 'src/app.ts')).toEqual({ label: 'Fast Mini', note: null });
  });

  it('uses the model chosen in Settings, and covers keys before anything is sent', async () => {
    const { ai, provider } = service([{ text: 'x' }], { settings: { editor: { suggestions: true, suggestionModel: MAIN.ref } } });
    await ai.complete({ ...ASK, requestId: 'r1', prefix: `const key = "${KEY}";\nconst answer = ` });
    expect(provider.requests[0]!.model.ref.modelId).toBe('fake-model');
    expect(JSON.stringify(provider.requests[0]!.messages)).not.toContain(KEY);
  });

  it('sends nothing for files that may hold secrets, when suggestions are off, or outside code sessions', async () => {
    const { ai, provider } = service([]);
    await expect(ai.complete({ ...ASK, requestId: 'r1', file: 'config/.env' })).rejects.toMatchObject({ code: 'secret_file' });
    expect((await ai.model('s1', '.env.local')).label).toBeNull();
    expect(await service([], { settings: { editor: { suggestions: false, suggestionModel: null } } }).ai.complete({ ...ASK, requestId: 'r2' })).toEqual({ text: '' });
    await expect(service([], { kind: 'chat' }).ai.complete({ ...ASK, requestId: 'r3' })).rejects.toMatchObject({ code: 'no_folder' });
    expect(provider.requests).toHaveLength(0);
  });

  it('ends a request when it is cancelled, also when the cancel comes first', async () => {
    const { ai, provider } = service([{ text: 'a b c d e f g h', chunkDelayMs: 200 }]);
    ai.cancel('early');
    await expect(ai.complete({ ...ASK, requestId: 'early' })).rejects.toMatchObject({ code: 'cancelled' });
    expect(provider.requests).toHaveLength(0);
    const pending = ai.complete({ ...ASK, requestId: 'late' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    ai.cancel('late');
    await expect(pending).rejects.toBeInstanceOf(GraftError);
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('turns a provider failure into a sentence with a code', async () => {
    const { ProviderError } = await import('../../src/main/providers/errors');
    const { ai } = service([{ error: new ProviderError('auth', 'Incorrect API key provided.') }]);
    await expect(ai.complete({ ...ASK, requestId: 'r1' })).rejects.toMatchObject({ code: 'provider_auth', message: 'Incorrect API key provided.' });
  });

  it('rewrites the selected lines on the session’s own model and refuses lines that hold a key', async () => {
    const { ai, provider } = service([{ text: '```\nFIRST\nSECOND\n```' }, { text: '' }]);
    const edit = { sessionId: 's1', file: 'notes.txt', language: 'plaintext', before: '', selection: 'first\nsecond', after: 'third', instruction: 'Shout it' };
    expect(await ai.inlineEdit({ ...edit, requestId: 'e1' })).toEqual({ replacement: 'FIRST\nSECOND' });
    expect(provider.requests[0]!.model.ref.modelId).toBe('fake-model');
    await expect(ai.inlineEdit({ ...edit, requestId: 'e2' })).rejects.toMatchObject({ code: 'edit_empty' });
    await expect(ai.inlineEdit({ ...edit, requestId: 'e3', selection: `const key = "${KEY}";` })).rejects.toMatchObject({ code: 'secret_in_selection' });
    expect(provider.requests).toHaveLength(2);
  });
});
