import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nodeModulesVolume, SandboxManager } from '../../src/main/sandbox/sandbox';
import { runFile } from '../../src/main/tools/run';
import { detectShell } from '../../src/main/tools/shell/detect';
import { ShellManager } from '../../src/main/tools/shell/shellManager';
import { makeTempDir, removeDir, writeFile } from '../support/tmp';

/**
 * The sandbox against a real engine. Needs Docker or Podman running, so it
 * only runs when asked: GRAFT_DOCKER_TESTS=1 npx vitest run sandbox.docker
 */
const enabled = process.env.GRAFT_DOCKER_TESTS === '1';
const SESSION = 'sandbox-it';
const LONG = 600_000;

describe.skipIf(!enabled)('sandbox with a real container engine', () => {
  const project = makeTempDir('graft sandbox (it) ');
  const logs = makeTempDir();
  const sandbox = new SandboxManager({ log: () => undefined });
  const shells = new ShellManager(detectShell(process.platform, process.env), logs, process.env, process.platform, sandbox);
  const target = { workspace: project, settings: { image: 'alpine:3.20', network: false, memoryMb: 512, cpus: 1 } };
  const exec = (command: string, timeoutMs = 120_000) => shells.run(SESSION, command, { cwd: project, timeoutMs, signal: new AbortController().signal });

  beforeAll(async () => {
    writeFile(project, '.git/config', '[core]\n\trepositoryformatversion = 0\n');
    writeFile(project, 'package.json', '{}\n');
    writeFile(project, 'src/a.txt', 'hello\n');
    await shells.setSandbox(SESSION, target);
  }, LONG);

  afterAll(async () => {
    const probe = await sandbox.probe();
    await shells.disposeAll();
    if (probe.status === 'ready') await runFile(probe.engine.path, ['volume', 'rm', nodeModulesVolume(project)], { cwd: os.homedir() });
    removeDir(project);
    removeDir(logs);
  }, LONG);

  it('runs commands in the container, with the project at /workspace', async () => {
    const r = await exec('pwd; cat src/a.txt; head -1 /etc/os-release');
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('/workspace');
    expect(r.output).toContain('hello');
    expect(r.output).toContain('Alpine');
  }, LONG);

  it('keeps the folder and exported variables between commands', async () => {
    await exec('cd src && export GREETING=hi');
    const r = await exec('pwd; echo "greeting=$GREETING"');
    expect(r.output).toContain('/workspace/src');
    expect(r.output).toContain('greeting=hi');
    expect(r.cwd).toBe(path.join(project, 'src'));
    await exec('cd /workspace');
  }, LONG);

  it('writes to the project but never to .git or .graft', async () => {
    const r = await exec('echo made > made.txt; (echo x > .git/planted) 2>/dev/null || echo git-read-only; (echo y > .graft/settings.json) 2>/dev/null || echo graft-read-only');
    expect(fs.readFileSync(path.join(project, 'made.txt'), 'utf8').trim()).toBe('made');
    expect(r.output).toContain('git-read-only');
    expect(r.output).toContain('graft-read-only');
    expect(fs.existsSync(path.join(project, '.git', 'planted'))).toBe(false);
    expect(fs.existsSync(path.join(project, '.graft', 'settings.json'))).toBe(false);
  }, LONG);

  it('sees none of this computer’s environment variables', async () => {
    process.env.GRAFT_PROBE_SECRET = 'must-not-leak';
    try {
      const r = await exec('env');
      expect(r.output).not.toContain('must-not-leak');
      expect(r.output).toContain('GRAFT_SANDBOX=1');
    } finally {
      delete process.env.GRAFT_PROBE_SECRET;
    }
  }, LONG);

  it('has no network when internet access is off', async () => {
    const r = await exec('wget -q -T 3 -O /dev/null http://example.com 2>/dev/null && echo online || echo offline');
    expect(r.output).toContain('offline');
  }, LONG);

  it('stops a command and everything it started when interrupted', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = shells.run(SESSION, 'sleep 61 & sleep 62; echo finished', { cwd: project, timeoutMs: 120_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 2000);
    const r = await pending;
    expect(r.interrupted).toBe(true);
    expect(r.output).not.toContain('finished');
    expect(Date.now() - started).toBeLessThan(30_000);
    const ps = await exec('ps');
    expect(ps.output).not.toMatch(/sleep 6[12]/);
  }, LONG);

  it('stops a command that runs past its time limit', async () => {
    const r = await exec('sleep 63', 3000);
    expect(r.timedOut).toBe(true);
    expect((await exec('ps')).output).not.toContain('sleep 63');
  }, LONG);

  it('runs background jobs and stops them', async () => {
    const job = await shells.startBackground(SESSION, 'while true; do echo tick; sleep 1; done', project);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(shells.readOutput(job.id)?.output).toContain('tick');
    expect(await shells.kill(job.id)).toBe(true);
    expect((await exec('ps')).output).not.toContain('echo tick');
  }, LONG);

  it('removes the container when the sandbox is turned off', async () => {
    const probe = await sandbox.probe();
    if (probe.status !== 'ready') throw new Error('engine went away');
    await shells.setSandbox(SESSION, null);
    const listed = await runFile(probe.engine.path, ['ps', '--all', '--quiet', '--filter', `label=graft.session=${SESSION}`], { cwd: os.homedir() });
    expect(listed.stdout.trim()).toBe('');
    // Back on this computer, the same session runs in the project folder again.
    const r = await exec(process.platform === 'win32' && shells.shell.kind === 'powershell' ? 'Get-Location' : 'pwd');
    expect(r.exitCode).toBe(0);
  }, LONG);
});

describe.skipIf(!enabled)('sandbox images with bash, git and the network', () => {
  const project = makeTempDir('graft sandbox (net) ');
  const logs = makeTempDir();
  const sandbox = new SandboxManager({ log: () => undefined });
  const shells = new ShellManager(detectShell(process.platform, process.env), logs, process.env, process.platform, sandbox);
  const settings = { network: true, memoryMb: 512, cpus: 1 };
  const exec = (session: string, command: string) => shells.run(session, command, { cwd: project, timeoutMs: 120_000, signal: new AbortController().signal });

  beforeAll(async () => {
    writeFile(project, 'README.md', '# demo\n');
    for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']]) {
      await runFile('git', args, { cwd: project });
    }
  }, LONG);

  afterAll(async () => {
    await shells.disposeAll();
    removeDir(project);
    removeDir(logs);
  }, LONG);

  it('keeps variables with bash, whose saved environment looks different from sh', async () => {
    await shells.setSandbox('bash', { workspace: project, settings: { ...settings, image: 'debian:bookworm-slim' } });
    await exec('bash', 'export PICKED="two words"; cd /tmp');
    const r = await exec('bash', 'echo "picked=$PICKED"; pwd; echo "shell=$BASH_VERSION"');
    expect(r.output).toContain('picked=two words');
    expect(r.output).toContain('/tmp');
    expect(r.output).toMatch(/shell=\d/);
    // /tmp has no folder on this computer, so the result names the container's.
    expect(r.cwd).toBe('/tmp');
  }, LONG);

  it('reads git history even though .git is read-only, and refuses to commit', async () => {
    await shells.setSandbox('git', { workspace: project, settings: { ...settings, image: 'alpine/git' } });
    writeFile(project, 'new.txt', 'x\n');
    const status = await exec('git', 'git status --short && git log --oneline -1');
    expect(status.exitCode).toBe(0);
    expect(status.output).toContain('?? new.txt');
    expect(status.output).toContain('init');
    const commit = await exec('git', 'git add new.txt && git -c user.name=a -c user.email=a@a commit -qm planted');
    expect(commit.exitCode).not.toBe(0);
    expect((await runFile('git', ['log', '--oneline'], { cwd: project })).stdout).not.toContain('planted');
    fs.rmSync(path.join(project, 'new.txt'));
  }, LONG);

  it('forwards a dev server in the sandbox to a port on this computer', async () => {
    await shells.setSandbox('net', { workspace: project, settings: { ...settings, image: 'alpine:3.20' } });
    // Alpine's busybox has no httpd; nc answering one request at a time is enough of a server.
    await shells.startBackground('net', 'while true; do printf "HTTP/1.0 200 OK\\r\\nContent-Length: 19\\r\\n\\r\\nserved-from-sandbox" | nc -l -p 5173; done', project);
    const hostPort = sandbox.box('net')?.ports[5173];
    expect(hostPort).toBeGreaterThan(0);
    let body = '';
    for (let i = 0; i < 20 && !body.includes('served'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      body = await fetch(`http://127.0.0.1:${hostPort}/`).then((res) => res.text(), () => '');
    }
    expect(body).toContain('served-from-sandbox');
  }, LONG);
});
