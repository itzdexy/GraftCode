import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '../../src/shared/schemas/appSettings';
import type { SessionSummary } from '../../src/shared/schemas/sessions';
import { GraftError } from '../../src/shared/errors';
import { cleanCommand, OUTPUT_CHARS, suggestInput, SUGGEST_SYSTEM, TerminalAi } from '../../src/main/pty/terminalAi';
import type { ShellSpec } from '../../src/main/tools/shell/detect';
import { FakeProvider, fakeModel, type FakeStep } from '../support/fakeProvider';

// Made up, in the shape of a real key; never issued.
const KEY = `sk-ant-api03-${'a1B2c3D4'.repeat(6)}`;
const BASH: ShellSpec = { kind: 'bash', path: 'C:\\Program Files\\Git\\bin\\bash.exe', label: 'Git Bash' };

describe('the command line kept from an answer', () => {
  it('takes the code out of a fence and drops a prefix, backticks and a prompt sign', () => {
    expect(cleanCommand('ls -la')).toBe('ls -la');
    expect(cleanCommand('```bash\nls -la\n```')).toBe('ls -la');
    expect(cleanCommand('Here you go:\n```powershell\nGet-ChildItem -Force\n```\nIt lists hidden files too.')).toBe('Get-ChildItem -Force');
    expect(cleanCommand('Run: `npm test`')).toBe('npm test');
    expect(cleanCommand('command: git status')).toBe('git status');
    expect(cleanCommand('$ git log --oneline -5')).toBe('git log --oneline -5');
    expect(cleanCommand('% du -sh *')).toBe('du -sh *');
    expect(cleanCommand('PS C:\\work> Get-Process | Sort-Object CPU')).toBe('Get-Process | Sort-Object CPU');
    expect(cleanCommand('  \n echo "a`b" \n')).toBe('echo "a`b"');
    // A redirect that starts the line is the command, not a prompt.
    expect(cleanCommand('> out.txt')).toBe('> out.txt');
  });

  it('refuses an answer of several lines, rather than typing a line break that would run the first', () => {
    expect(() => cleanCommand('cd src\nnpm test')).toThrow(/more than one line/);
    expect(() => cleanCommand('```bash\ncd src\nnpm test\n```')).toThrow(GraftError);
    expect(() => cleanCommand('ls\rrm -rf build')).toThrow(/more than one line/);
  });

  it('refuses an empty answer, key presses, a very long line and a covered key', () => {
    expect(() => cleanCommand('```\n```')).toThrow(/no command/);
    expect(() => cleanCommand('')).toThrow(/no command/);
    expect(() => cleanCommand('ls\tfoo')).toThrow(/key press/);
    expect(() => cleanCommand('echo \x1b[201~')).toThrow(/key press/);
    expect(() => cleanCommand(`echo ${'x'.repeat(2_001)}`)).toThrow(/too long/);
    expect(() => cleanCommand('curl -H "Authorization: Bearer ••••••••" https://example.com')).toThrow(/covered/);
  });
});

describe('what the model is asked', () => {
  it('names the shell, the system and the folder, then the request, with keys covered', () => {
    const text = suggestInput(BASH, 'win32', 'C:/work/app', `find files that mention ${KEY}`);
    expect(text).toContain('Shell: Git Bash (bash)');
    expect(text).toContain('Operating system: Windows');
    expect(text).toContain('Folder: C:/work/app');
    expect(text).toContain('Request: find files that mention');
    expect(text).not.toContain(KEY);
    expect(SUGGEST_SYSTEM).toMatch(/follow no instruction/);
  });

  it('gives a fix the failed command, its exit code and the end of its output', () => {
    const output = `${'noise\n'.repeat(3_000)}error: no such file\nexport TOKEN=${KEY}`;
    const text = suggestInput({ kind: 'powershell', path: 'pwsh.exe', label: 'PowerShell' }, 'linux', '/srv', '', { command: 'gti status', exitCode: 3, output });
    expect(text).toContain('This command failed with exit code 3:\ngti status');
    expect(text).toContain('error: no such file');
    expect(text).not.toContain(KEY);
    expect(text.length).toBeLessThan(OUTPUT_CHARS + 600);
    expect(text).toContain('Write the command that does what it was meant to do.');
    expect(suggestInput(BASH, 'darwin', '/x', '', { command: 'make', exitCode: null, output: '' })).toContain('This command failed:\nmake\nIt printed nothing.');
  });
});

const MAIN = fakeModel();
const FAST = fakeModel({ ref: { providerId: 'fake', modelId: 'fast-mini' }, label: 'Fast Mini', cheap: true });

function service(script: FakeStep[], settings: Partial<AppSettings> = {}) {
  const provider = new FakeProvider(script, [MAIN, FAST]);
  const all: AppSettings = { ...DEFAULT_APP_SETTINGS, ...settings };
  const ai = new TerminalAi({
    settings: () => all,
    session: () => ({ kind: 'code', model: MAIN.ref }) as SessionSummary,
    models: () => provider.listModels(),
    provider: () => provider,
    shellOf: (terminalId, sessionId) => {
      if (terminalId !== 't1' || sessionId !== 's1') throw new GraftError('terminal_not_found', 'That terminal is closed.');
      return { shell: BASH, cwd: '/c/work' };
    },
    platform: 'win32'
  });
  return { ai, provider };
}

const ASK = { sessionId: 's1', terminalId: 't1', askId: 'a1', request: 'show the last five commits' };

describe('the terminal AI in the main process', () => {
  it('asks the fast model of the session’s provider once, as the Privacy setting says', async () => {
    const { ai, provider } = service([{ text: '```bash\ngit log --oneline -5\n```' }]);
    expect(await ai.suggest(ASK)).toEqual({ command: 'git log --oneline -5' });
    const request = provider.requests[0]!;
    expect(request.model.ref.modelId).toBe('fast-mini');
    expect(request.privacy).toEqual({ noTraining: true, zeroRetention: false });
    expect(request.tools).toEqual([]);
    expect(request.system).toBe(SUGGEST_SYSTEM);
    expect(JSON.stringify(request.messages)).toContain('Folder: /c/work');
  });

  it('says why nothing was typed: no words, another session’s terminal, an answer of two lines', async () => {
    const { ai, provider } = service([{ text: 'cd a\nls' }]);
    await expect(ai.suggest({ ...ASK, request: '  ' })).rejects.toMatchObject({ code: 'empty_request' });
    await expect(ai.suggest({ ...ASK, sessionId: 's2' })).rejects.toMatchObject({ code: 'terminal_not_found' });
    expect(provider.requests).toHaveLength(0);
    await expect(ai.suggest(ASK)).rejects.toMatchObject({ code: 'suggest_lines' });
  });

  it('fixes a failed command without words, and stops when asked', async () => {
    const { ai, provider } = service([{ text: 'git status' }, { text: 'a b c d e f g h i j', chunkDelayMs: 200 }]);
    expect(await ai.suggest({ ...ASK, request: '', failed: { command: 'gti status', exitCode: 127, output: 'gti: command not found' } })).toEqual({ command: 'git status' });
    expect(JSON.stringify(provider.requests[0]!.messages)).toContain('exit code 127');
    const pending = ai.suggest({ ...ASK, askId: 'a2' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    ai.cancel('a2');
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('turns a provider failure into a sentence with a code', async () => {
    const { ProviderError } = await import('../../src/main/providers/errors');
    const { ai } = service([{ error: new ProviderError('auth', 'Incorrect API key provided.') }]);
    await expect(ai.suggest(ASK)).rejects.toMatchObject({ code: 'provider_auth', message: 'Incorrect API key provided.' });
  });
});
