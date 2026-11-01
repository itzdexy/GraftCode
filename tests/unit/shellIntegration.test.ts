import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MarkScanner, parseMark } from '../../src/shared/terminalMarks';
import { PtyManager } from '../../src/main/pty/ptyManager';
import { shellLaunch, writeLaunchFiles } from '../../src/main/pty/shellIntegration';
import { detectShell, type ShellSpec } from '../../src/main/tools/shell/detect';

const DIR = path.join(os.tmpdir(), 'graft-shell-integration');
const ESC = '\x1b';
const BEL = '\x07';
const osc = (body: string): string => `${ESC}]${body}${BEL}`;

function decoded(args: string[]): string {
  return Buffer.from(args[args.indexOf('-EncodedCommand') + 1] ?? '', 'base64').toString('utf16le');
}

describe('how each shell starts with its marks', () => {
  it('gives bash an init file that reads the login files first, then marks prompt, command, output and exit code', () => {
    const launch = shellLaunch({ kind: 'bash', path: '/usr/bin/bash', label: 'bash' }, '/data/shell-integration', {}, 'linux');
    expect(launch?.args).toEqual(['--init-file', path.join('/data/shell-integration', 'graft.bash'), '-i']);
    expect(launch?.env).toEqual({ GRAFT_SHELL_LOGIN: '1' });
    const script = launch?.files['graft.bash'] ?? '';
    expect(script.indexOf('. /etc/profile')).toBeLessThan(script.indexOf('PROMPT_COMMAND='));
    expect(script).toContain('~/.bash_profile');
    expect(script).toContain('~/.bashrc');
    expect(script).toContain("printf '\\033]133;D;%s\\007\\033]133;A\\007\\033]133;P;Cwd=%s\\007' \"$__graft_code\" \"$PWD\"");
    expect(script).toContain("PS1=$PS1'\\[\\033]133;B\\007\\]'");
    expect(script).toContain("PS0=${PS0:-}'\\033]133;C\\007'");
    // The user's own prompt command keeps running, between the two of Graft's.
    expect(script).toContain('PROMPT_COMMAND=$\'__graft_status\\n\'"${PROMPT_COMMAND:-}"$\'\\n__graft_prompt\'');
    expect(script).not.toContain('\r');
  });

  it('writes the init file path of Git Bash with forward slashes', () => {
    const launch = shellLaunch({ kind: 'bash', path: 'C:\\Program Files\\Git\\bin\\bash.exe', label: 'Git Bash' }, 'C:\\Users\\me\\AppData\\Graft\\shell-integration', {}, 'win32');
    expect(launch?.args[1]).not.toContain('\\');
    expect(launch?.args[1]).toMatch(/graft\.bash$/);
  });

  it('points zsh at a folder whose files read the user’s own, from the ZDOTDIR they set', () => {
    const shell: ShellSpec = { kind: 'zsh', path: '/bin/zsh', label: 'zsh' };
    const launch = shellLaunch(shell, '/data/si', {}, 'darwin');
    expect(launch?.args).toEqual(['--login', '-i']);
    expect(launch?.env).toEqual({ ZDOTDIR: path.join('/data/si', 'zsh') });
    expect(Object.keys(launch?.files ?? {}).sort()).toEqual(['zsh/.zlogin', 'zsh/.zprofile', 'zsh/.zshenv', 'zsh/.zshrc']);
    for (const name of ['.zshenv', '.zprofile', '.zshrc', '.zlogin']) expect(launch?.files[`zsh/${name}`]).toContain(`source $ZDOTDIR/${name}`);
    const rc = launch?.files['zsh/.zshrc'] ?? '';
    expect(rc).toContain('precmd_functions=(__graft_status $precmd_functions __graft_precmd)');
    expect(rc).toContain('preexec_functions+=(__graft_preexec)');
    expect(rc).toContain("printf '\\e]133;C\\a'");
    expect(launch?.files['zsh/.zlogin']).toContain('unset GRAFT_USER_ZDOTDIR GRAFT_ZDOTDIR');
    expect(shellLaunch(shell, '/data/si', { ZDOTDIR: '/home/me/.config/zsh' }, 'darwin')?.env.GRAFT_USER_ZDOTDIR).toBe('/home/me/.config/zsh');
  });

  it('runs a command after the PowerShell profile that wraps its prompt, with no script file to be refused', () => {
    for (const file of ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', '/usr/bin/pwsh']) {
      const launch = shellLaunch({ kind: 'powershell', path: file, label: 'PowerShell' }, 'C:\\data', {}, 'win32');
      expect(launch?.args.slice(0, 3)).toEqual(['-NoLogo', '-NoExit', '-EncodedCommand']);
      expect(launch?.files).toEqual({});
      const script = decoded(launch?.args ?? []);
      expect(script).toContain('$Global:__GraftPrompt = $function:prompt');
      expect(script).toContain('function Global:prompt');
      expect(script).toContain('$out += "$e]133;D;$exit$b"');
      expect(script).toContain('function Global:PSConsoleHostReadLine');
    }
  });

  it('starts cmd.exe, sh and shells it does not know as they always started', () => {
    expect(shellLaunch({ kind: 'bash', path: 'C:\\Windows\\System32\\cmd.exe', label: 'cmd.exe' }, DIR, {}, 'win32')).toBeNull();
    expect(shellLaunch({ kind: 'sh', path: '/bin/sh', label: 'sh' }, DIR, {}, 'linux')).toBeNull();
    expect(shellLaunch({ kind: 'bash', path: '/usr/bin/fish', label: 'fish' }, DIR, {}, 'linux')).toBeNull();
  });

  it('writes the files once and leaves them alone while they say the same', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-si-'));
    try {
      writeLaunchFiles(dir, { 'zsh/.zshrc': 'one' });
      const file = path.join(dir, 'zsh', '.zshrc');
      const written = fs.statSync(file).mtimeMs;
      writeLaunchFiles(dir, { 'zsh/.zshrc': 'one' });
      expect(fs.statSync(file).mtimeMs).toBe(written);
      writeLaunchFiles(dir, { 'zsh/.zshrc': 'two' });
      expect(fs.readFileSync(file, 'utf8')).toBe('two');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('reading the marks', () => {
  it('knows each mark and the exit code it carries', () => {
    expect(parseMark(133, 'A')).toEqual({ kind: 'prompt' });
    expect(parseMark(133, 'B')).toEqual({ kind: 'command' });
    expect(parseMark(133, 'C')).toEqual({ kind: 'output' });
    expect(parseMark(133, 'D;3')).toEqual({ kind: 'done', exitCode: 3 });
    expect(parseMark(133, 'D;0')).toEqual({ kind: 'done', exitCode: 0 });
    expect(parseMark(133, 'D;-1073741819')).toEqual({ kind: 'done', exitCode: -1073741819 });
    expect(parseMark(133, 'D')).toEqual({ kind: 'done', exitCode: null });
    expect(parseMark(133, 'D;oops')).toEqual({ kind: 'done', exitCode: null });
    expect(parseMark(133, 'Z')).toBeNull();
    expect(parseMark(0, 'title')).toBeNull();
  });

  it('reads the folder from the 133 extension and from OSC 7', () => {
    expect(parseMark(133, 'P;Cwd=C:\\work\\a;b')).toEqual({ kind: 'cwd', path: 'C:\\work\\a;b' });
    expect(parseMark(133, 'P;Cwd=')).toBeNull();
    expect(parseMark(7, 'file://host/home/me/my%20project')).toEqual({ kind: 'cwd', path: '/home/me/my project' });
    expect(parseMark(7, 'file:///C:/work')).toEqual({ kind: 'cwd', path: 'C:/work' });
    expect(parseMark(7, 'file://host/%E0%A4%A')).toBeNull();
    expect(parseMark(7, 'http://example.com/')).toBeNull();
  });

  it('finds marks split between chunks, ended by BEL or ST, among other output', () => {
    const scanner = new MarkScanner();
    const stream = `hello${osc('0;title')}${osc('133;D;3')}${osc('133;A')}${ESC}]133;P;Cwd=/tmp/x${ESC}\\$ ${osc('133;B')}`;
    const found = [];
    // Every way of cutting the stream in two gives the same marks.
    for (let cut = 0; cut <= stream.length; cut++) {
      const one = new MarkScanner();
      expect([...one.scan(stream.slice(0, cut)), ...one.scan(stream.slice(cut))]).toEqual([
        { kind: 'done', exitCode: 3 },
        { kind: 'prompt' },
        { kind: 'cwd', path: '/tmp/x' },
        { kind: 'command' }
      ]);
    }
    // One character at a time.
    for (const char of stream) found.push(...scanner.scan(char));
    expect(found).toHaveLength(4);
  });

  it('lets go of a sequence that never ends', () => {
    const scanner = new MarkScanner();
    expect(scanner.scan(`${ESC}]133;P;Cwd=${'x'.repeat(10_000)}`)).toEqual([]);
    expect(scanner.scan(`${BEL}${osc('133;A')}`)).toEqual([{ kind: 'prompt' }]);
  });
});

describe('a real terminal with the marks', () => {
  const shell = detectShell(process.platform, process.env);
  it('marks a failed command with its exit code and follows the folder the shell moves to', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-si-run-'));
    fs.mkdirSync(path.join(dir, 'inner'));
    const chunks: string[] = [];
    const manager = new PtyManager(shell, { data: (_id, data) => chunks.push(data), exit: () => undefined, log: () => undefined }, process.platform, path.join(dir, 'si'));
    const term = manager.create('s1', dir, 120, 30);
    const joined = (): string => chunks.join('');
    const until = async (test: () => boolean): Promise<void> => {
      const deadline = Date.now() + 20_000;
      while (!test() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    };
    try {
      await until(() => joined().includes(osc('133;B')));
      const fail = shell.kind === 'powershell' ? 'cmd /c exit 3' : '(exit 3)';
      manager.write(term.id, `${fail}\r`);
      await until(() => joined().includes(osc('133;D;3')));
      expect(joined()).toContain(osc('133;C'));
      expect(joined()).toContain(osc('133;D;3'));
      manager.write(term.id, 'cd inner\r');
      await until(() => /inner$/.test(manager.list('s1')[0]?.cwd ?? ''));
      expect(manager.shellOf(term.id, 's1').cwd).toMatch(/inner$/);
      expect(() => manager.shellOf(term.id, 'someone-else')).toThrow(/closed/);
    } finally {
      await manager.kill(term.id);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
