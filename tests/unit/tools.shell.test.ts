import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectShell } from '../../src/main/tools/shell/detect';
import { OutputBuffer, stripAnsi } from '../../src/main/tools/shell/outputBuffer';
import { BASH_WRAPPER, msysTreeWinPids } from '../../src/main/tools/shell/shellManager';
import { killShellTool, shellOutputTool, shellTool } from '../../src/main/tools/shell/shellTools';
import { fetchPage, pointsInside, redirectProblem, webFetchTool, WebFetchInput } from '../../src/main/tools/web/webFetch';
import { htmlToText } from '../../src/main/tools/web/htmlToText';
import { askUserTool, exitPlanModeTool, taskTool, todoWriteTool } from '../../src/main/tools/agentTools';
import { json, startFixtureServer, type FixtureServer } from '../support/httpFixture';
import { makeTempDir, removeDir } from '../support/tmp';
import { makeToolContext } from '../support/toolContext';

let dir: string;
beforeEach(() => {
  dir = makeTempDir();
});
afterEach(() => {
  removeDir(dir);
});

const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? '').join('\n');
const isPowerShell = detectShell(process.platform, process.env).kind === 'powershell';

describe('shell detection', () => {
  it('prefers Git Bash on Windows and never WSL bash, else PowerShell', () => {
    const env = { ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32' };
    const withGit = detectShell('win32', env, (p) => p === 'C:\\Program Files\\Git\\bin\\bash.exe');
    expect(withGit).toMatchObject({ kind: 'bash', label: 'Git Bash' });
    const withoutGit = detectShell('win32', env, (p) => p === 'C:\\Windows\\System32\\bash.exe');
    expect(withoutGit.kind).toBe('powershell');
    expect(detectShell('linux', { SHELL: '/usr/bin/zsh' }, (p) => p === '/usr/bin/zsh')).toMatchObject({ kind: 'zsh' });
    expect(detectShell('linux', {}, (p) => p === '/bin/bash')).toMatchObject({ kind: 'bash', path: '/bin/bash' });
  });

  it('finds MSYS descendants that Windows no longer parents (regression: orphaned sleep survived taskkill /T)', () => {
    const ps = [
      '      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND',
      '       90       1      90       2196  ?         197609 18:32:31 /usr/bin/bash',
      '       46      45      45      15396  ?         197609 18:32:07 /usr/bin/sleep',
      '       94       1      94      10176  ?         197609 18:32:31 /usr/bin/bash',
      '       95      94      94      27876  ?         197609 18:32:31 /usr/bin/sleep',
      '      101      95     101      30000  ?         197609 18:32:31 /usr/bin/node',
      'I      97      94      94      10968  ?         197609 18:32:32 /usr/bin/ps'
    ].join('\n');
    expect(msysTreeWinPids(ps, 94).sort()).toEqual([10176, 10968, 27876, 30000].sort());
  });

  it.skipIf(process.platform === 'win32' && detectShell('win32', process.env).kind !== 'bash')('records the actual Bash PID for process-tree cleanup', async () => {
    const pidFile = path.join(dir, 'wrapper.pid');
    const expectedPidFile = path.join(dir, 'wrapper.expected');
    const bashPath = process.platform === 'win32' ? detectShell('win32', process.env).path : '/bin/bash';
    const shellCwd = process.platform === 'win32' ? dir.split(path.sep).join('/') : dir;
    const child = spawn(bashPath, ['--noprofile', '--norc', '-c', BASH_WRAPPER], {
      cwd: dir,
      env: {
        ...process.env,
        GRAFT_STATE_CWD: path.join(dir, 'wrapper.cwd'),
        GRAFT_STATE_ENV: path.join(dir, 'wrapper.env'),
        GRAFT_STATE_PID: pidFile,
        GRAFT_EXPECTED_PID: expectedPidFile,
        GRAFT_CWD: shellCwd,
        GRAFT_CMD: 'printf "%s" "$$" > "$GRAFT_EXPECTED_PID"'
      },
      stdio: 'ignore'
    });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    expect(exitCode).toBe(0);
    const recordedPid = fs.readFileSync(pidFile, 'utf8').trim();
    const expectedPid = fs.readFileSync(expectedPidFile, 'utf8').trim();
    expect(recordedPid).toMatch(/^\d+$/);
    expect(recordedPid).toBe(expectedPid);
  });

  it('keeps head and tail of long output and strips ANSI codes', () => {
    const buffer = new OutputBuffer(10, 10);
    buffer.append('0123456789');
    buffer.append('x'.repeat(100));
    buffer.append('END_OF_OUT');
    expect(buffer.truncated).toBe(true);
    expect(buffer.text('/tmp/log')).toMatch(/^0123456789\n\n… \[100 characters omitted\. Full output: \/tmp\/log\]\n\nEND_OF_OUT$/);
    expect(stripAnsi('\u001b[31mred\u001b[0m text')).toBe('red text');
  });
});

describe('Shell tool', () => {
  it('runs a command, reports the exit code and streams output', async () => {
    const ctx = makeToolContext(dir);
    const result = await shellTool.execute({ command: isPowerShell ? 'Write-Output hello' : 'echo hello' }, ctx);
    expect(result.isError).toBe(false);
    expect(text(result)).toMatch(/hello\n\nExit code 0\./);
    expect(ctx.progressChunks.join('')).toContain('hello');
    expect(result.display).toMatchObject({ kind: 'shell', exitCode: 0, timedOut: false });
    const failed = await shellTool.execute({ command: 'exit 3' }, ctx);
    expect(failed.isError).toBe(true);
    expect(text(failed)).toMatch(/Exit code 3\./);
  });

  it('persists the working directory and exported variables between calls', async () => {
    fs.mkdirSync(path.join(dir, 'sub dir'));
    const ctx = makeToolContext(dir);
    if (isPowerShell) {
      await shellTool.execute({ command: "Set-Location 'sub dir'; $env:GRAFT_TEST_VAR = 'kept'" }, ctx);
      expect(text(await shellTool.execute({ command: '(Get-Location).Path; $env:GRAFT_TEST_VAR' }, ctx))).toMatch(/sub dir[\s\S]*kept/);
    } else {
      const first = await shellTool.execute({ command: 'cd "sub dir" && export TEST_VALUE="kept value"' }, ctx);
      expect(text(first)).toMatch(/Working directory is now .*sub dir/);
      const second = await shellTool.execute({ command: 'basename "$PWD"; echo "$TEST_VALUE"' }, ctx);
      expect(text(second)).toMatch(/^sub dir\nkept value/);
    }
  });

  it('times out long commands and kills them', async () => {
    const ctx = makeToolContext(dir);
    const started = Date.now();
    const result = await shellTool.execute({ command: isPowerShell ? 'Start-Sleep -Seconds 30' : 'sleep 30', timeout_ms: 1500 }, ctx);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/Timed out after 2s/);
    expect(result.display).toMatchObject({ timedOut: true });
  });

  it('stops when interrupted', async () => {
    const controller = new AbortController();
    const ctx = makeToolContext(dir, { signal: controller.signal });
    setTimeout(() => controller.abort(), 500);
    const result = await shellTool.execute({ command: isPowerShell ? 'Start-Sleep -Seconds 30' : 'sleep 30' }, ctx);
    expect(text(result)).toMatch(/Interrupted by the user/);
    expect(result.display).toMatchObject({ interrupted: true });
  });

  it('truncates huge output for the model but keeps the full log on disk', async () => {
    const ctx = makeToolContext(dir);
    const command = isPowerShell
      ? '1..8000 | ForEach-Object { "line $_ padding padding padding" }'
      : 'for i in $(seq 1 8000); do echo "line $i padding padding padding"; done';
    const result = await shellTool.execute({ command }, ctx);
    const display = result.display.kind === 'shell' ? result.display : null;
    expect(display?.truncated).toBe(true);
    expect(text(result)).toMatch(/characters omitted\. Full output: /);
    expect(text(result)).toContain('line 8000');
    const log = fs.readFileSync(display?.logPath ?? '', 'utf8');
    expect(log).toContain('line 4000 padding');
  });

  it('runs background jobs that can be polled and killed', async () => {
    const ctx = makeToolContext(dir);
    const command = isPowerShell
      ? "Write-Output 'started'; Start-Sleep -Seconds 30"
      : 'echo started; sleep 30';
    const started = await shellTool.execute({ command, run_in_background: true }, ctx);
    const id = started.display.kind === 'shell' ? started.display.backgroundId : null;
    expect(id).toMatch(/^bg-/);
    let output = '';
    for (let i = 0; i < 50 && !output.includes('started'); i++) {
      await new Promise((r) => setTimeout(r, 100));
      output += text(await shellOutputTool.execute({ shell_id: id! }, ctx));
    }
    expect(output).toContain('started');
    expect(output).toContain('Still running.');
    const killed = await killShellTool.execute({ shell_id: id! }, ctx);
    expect(text(killed)).toBe(`Stopped ${id}.`);
    expect(ctx.shells.list(ctx.sessionId)[0]?.status).toBe('killed');
    expect((await shellOutputTool.execute({ shell_id: 'bg-nope' }, ctx)).isError).toBe(true);
  });
});

describe('WebFetch', () => {
  let server: FixtureServer;
  beforeEach(async () => {
    server = await startFixtureServer();
  });
  afterEach(async () => {
    await server.close();
  });

  it('converts HTML to readable text with title and absolute links', async () => {
    server.route('GET', '/docs', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><head><title>Guide &amp; Notes</title><style>x{}</style></head><body><h1>Install</h1><p>Run <code>make</code> then see <a href="/next">the next step</a>.</p><script>alert(1)</script><ul><li>one</li><li>two</li></ul></body></html>');
    });
    const result = await webFetchTool.execute({ url: `${server.url}/docs` }, makeToolContext(dir));
    const body = text(result);
    expect(body).toContain('Title: Guide & Notes');
    expect(body).toContain('# Install');
    expect(body).toContain(`[the next step](${server.url}/next)`);
    expect(body).toContain('- one');
    expect(body).not.toContain('alert(1)');
    expect(result.display).toMatchObject({ kind: 'fetch', status: 200, title: 'Guide & Notes' });
  });

  it('rejects non-http URLs at validation and binary content at runtime', async () => {
    expect(WebFetchInput.safeParse({ url: 'file:///etc/passwd' }).success).toBe(false);
    expect(WebFetchInput.safeParse({ url: 'javascript:alert(1)' }).success).toBe(false);
    server.route('GET', '/bin', (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.from([0, 1, 2]));
    });
    server.route('GET', '/missing', (_req, res) => json(res, 404, { error: 'nope' }));
    expect(text(await webFetchTool.execute({ url: `${server.url}/bin` }, makeToolContext(dir)))).toMatch(/can't show as text/);
    expect((await webFetchTool.execute({ url: `${server.url}/missing` }, makeToolContext(dir))).isError).toBe(true);
  });

  it('follows a page that moved, and says which address was asked for', async () => {
    server.route('GET', '/old', (_req, res) => {
      res.writeHead(302, { location: '/new?x=1' });
      res.end();
    });
    server.route('GET', '/new', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('moved here');
    });
    const result = await webFetchTool.execute({ url: `${server.url}/old` }, makeToolContext(dir));
    expect(text(result)).toContain('moved here');
    expect(result.display).toMatchObject({ kind: 'fetch', url: `${server.url}/new?x=1`, requested: `${server.url}/old`, status: 200 });
    // A page that did not move records no second address.
    const direct = await webFetchTool.execute({ url: `${server.url}/new` }, makeToolContext(dir));
    expect(direct.display && 'requested' in direct.display).toBe(false);

    server.route('GET', '/loop', (_req, res) => {
      res.writeHead(302, { location: '/loop' });
      res.end();
    });
    expect(text(await webFetchTool.execute({ url: `${server.url}/loop` }, makeToolContext(dir)))).toMatch(/redirected too many times/i);
  });

  it('never follows the web into this computer or the local network', async () => {
    // From the public web to an address inside: what a hostile page does to read a router or a local service.
    expect(redirectProblem('https://example.com/a', 'http://192.168.1.1/admin')).toBe('The page redirected to an address on this computer or a private network, which is not followed.');
    expect(redirectProblem('https://example.com/a', 'http://localhost:11434/api/tags')).not.toBeNull();
    expect(redirectProblem('https://example.com/a', 'file:///etc/passwd')).toBe('The page redirected to an address that is not http(s), which is not followed.');
    // Within the web, and within what the user already allowed, a redirect is just a redirect.
    expect(redirectProblem('https://example.com/a', 'https://www.example.com/a/')).toBeNull();
    expect(redirectProblem('http://localhost:3000/', 'http://localhost:3000/login')).toBeNull();

    // A name that looks public but points inside (the trick is called DNS rebinding) is refused where pages are read without asking.
    const lookup = (host: string): Promise<Array<{ address: string }>> => Promise.resolve([{ address: host === 'rebind.example' ? '127.0.0.1' : '93.184.216.34' }]);
    expect(await pointsInside('rebind.example', lookup)).toBe(true);
    expect(await pointsInside('example.com', lookup)).toBe(false);
    expect(await pointsInside('gone.example', () => Promise.reject(new Error('ENOTFOUND')))).toBe(false);
    const guarded = makeToolContext(dir, { publicWebOnly: true });
    server.route('GET', '/ok', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('local page');
    });
    // An address that is plainly local was asked for by name and allowed by the user: it is read.
    expect(text(await webFetchTool.execute({ url: `${server.url}/ok` }, guarded))).toContain('local page');
  });

  it('reaches a server on this computer by name, whichever kind of address it listens on', async () => {
    // "localhost" is two addresses. A dev server often listens on one of them only, and the first one tried may be the other.
    const tried: string[] = [];
    const only = (reachable: string) => (url: string): Promise<Response> => {
      tried.push(url);
      return new URL(url).hostname === reachable ? Promise.resolve(new Response('ok')) : Promise.reject(new TypeError('fetch failed'));
    };
    expect(await (await fetchPage('http://localhost:5173/app?x=1', {}, only('[::1]'))).text()).toBe('ok');
    expect(tried).toEqual(['http://localhost:5173/app?x=1', 'http://127.0.0.1:5173/app?x=1', 'http://[::1]:5173/app?x=1']);
    tried.length = 0;
    expect(await (await fetchPage('http://localhost:5173/', {}, only('127.0.0.1'))).text()).toBe('ok');
    expect(tried).toEqual(['http://localhost:5173/', 'http://127.0.0.1:5173/']);
    // Nothing listening at all: the first failure is the one reported. Any other host is tried once.
    await expect(fetchPage('http://localhost:9/', {}, only('nowhere'))).rejects.toThrow('fetch failed');
    tried.length = 0;
    await expect(fetchPage('https://example.com/', {}, only('nowhere'))).rejects.toThrow('fetch failed');
    expect(tried).toEqual(['https://example.com/']);
    // A stop is a stop, not a reason to try another address.
    const stopped = new AbortController();
    stopped.abort();
    tried.length = 0;
    await expect(fetchPage('http://localhost:5173/', { signal: stopped.signal }, only('[::1]'))).rejects.toThrow();
    expect(tried).toEqual(['http://localhost:5173/']);
  });

  it('decodes entities and drops non-http links', () => {
    expect(htmlToText('<p>a&nbsp;&lt;b&gt; &#65;&#x42;</p><a href="javascript:x()">click</a>')).toBe('a <b> AB\n\nclick');
  });
});

describe('agent interaction tools', () => {
  it('TodoWrite replaces the list and nudges toward one in-progress item', async () => {
    const ctx = makeToolContext(dir);
    const result = await todoWriteTool.execute(
      {
        todos: [
          { content: 'Write tests', status: 'completed' },
          { content: 'Fix bug', status: 'in_progress', activeForm: 'Fixing bug' },
          { content: 'Ship', status: 'in_progress' }
        ]
      },
      ctx
    );
    expect(ctx.todoList).toHaveLength(3);
    expect(text(result)).toMatch(/1 done, 2 in progress, 0 pending\. Keep only one item in progress/);
  });

  it('AskUserQuestion formats answers, skips and dismissal', async () => {
    const questions = [
      { question: 'Which database?', options: [{ label: 'SQLite (Recommended)' }, { label: 'Postgres' }] },
      { question: 'Add docs?', options: [{ label: 'Yes' }, { label: 'No' }] }
    ];
    const answered = await askUserTool.execute(
      { questions },
      makeToolContext(dir, { askUser: () => Promise.resolve([{ selected: ['SQLite (Recommended)'], other: 'with WAL' }, null]) })
    );
    expect(text(answered)).toBe('Q: Which database?\nA: SQLite (Recommended); with WAL\n\nQ: Add docs?\nA: (skipped)');
    const dismissed = await askUserTool.execute({ questions }, makeToolContext(dir));
    expect(text(dismissed)).toMatch(/closed the questions/);
  });

  it('ExitPlanMode reports approval or feedback, and Task returns the sub-agent report', async () => {
    const approved = await exitPlanModeTool.execute(
      { plan: '1. Do it' },
      makeToolContext(dir, { approvePlan: (plan) => Promise.resolve({ approved: true, feedback: null, plan }) })
    );
    expect(text(approved)).toMatch(/approved the plan/);
    const rejected = await exitPlanModeTool.execute(
      { plan: '1. Do it' },
      makeToolContext(dir, { approvePlan: (plan) => Promise.resolve({ approved: false, feedback: 'Add tests first', plan }) })
    );
    expect(text(rejected)).toMatch(/Feedback: Add tests first/);
    const calls: string[] = [];
    const task = await taskTool.execute(
      { description: 'Find callers', prompt: 'Find every caller of foo()', subagent_type: 'explore' },
      makeToolContext(dir, {
        runSubagent: (input) => {
          calls.push(input.type);
          return Promise.resolve({ text: 'foo() is called from a.ts and b.ts', toolCalls: 4 });
        }
      })
    );
    expect(calls).toEqual(['explore']);
    expect(task.display).toMatchObject({ kind: 'task', toolCalls: 4 });
    expect(taskTool.concurrencySafe({ description: 'x', prompt: 'y', subagent_type: 'explore' })).toBe(true);
    expect(taskTool.concurrencySafe({ description: 'x', prompt: 'y' })).toBe(false);
  });
});
