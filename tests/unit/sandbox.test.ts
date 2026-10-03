import { describe, expect, it } from 'vitest';
import { engineProblem, probeEngine, type Runner } from '../../src/main/sandbox/engine';
import {
  containerName,
  execArgs,
  FORWARDED_PORTS,
  IMAGE_PATTERN,
  mountValue,
  nodeModulesVolume,
  parsePorts,
  runArgs,
  SANDBOX_WRAPPER,
  toContainerPath,
  toHostPath,
  type RunPlan
} from '../../src/main/sandbox/sandbox';
import { decide, type PermissionEnv } from '../../src/main/permissions/engine';
import { parseRule } from '../../src/main/permissions/rules';
import { buildCodeSystemPrompt, type CodePromptContext } from '../../src/main/agent/systemPrompt';
import { makeTempDir, writeFile } from '../support/tmp';

const plan = (overrides: Partial<RunPlan> = {}): RunPlan => ({
  name: 'graft-s1',
  sessionId: 's1',
  target: { workspace: 'C:\\Users\\me\\proj', settings: { image: 'node:22-bookworm', network: true, memoryMb: 4096, cpus: 2 } },
  stateDir: 'C:\\Users\\me\\AppData\\graft\\shell\\s1\\sandbox',
  engine: { kind: 'docker', cpus: 8, rootless: false },
  platform: 'win32',
  hostUser: null,
  readOnly: ['.git', '.graft'],
  hasPackageJson: true,
  ...overrides
});

function valuesOf(args: string[], flag: string): string[] {
  return args.flatMap((a, i) => (a === flag && args[i + 1] !== undefined ? [args[i + 1]!] : []));
}

describe('sandbox paths', () => {
  it('maps folders in the project to /workspace and back', () => {
    const ws = 'C:\\Users\\me\\proj';
    expect(toContainerPath(ws, ws, 'win32')).toBe('/workspace');
    expect(toContainerPath('C:\\Users\\me\\proj\\src\\lib', ws, 'win32')).toBe('/workspace/src/lib');
    // Anything outside the project starts at the project root in the container.
    expect(toContainerPath('C:\\Users\\me', ws, 'win32')).toBe('/workspace');
    expect(toContainerPath('D:\\other', ws, 'win32')).toBe('/workspace');
    expect(toHostPath('/workspace/src/lib', ws, 'win32')).toBe('C:\\Users\\me\\proj\\src\\lib');
    expect(toHostPath('/workspace', ws, 'win32')).toBe(ws);
    expect(toHostPath('/workspace/../etc', ws, 'win32')).toBeNull();
    expect(toHostPath('/tmp', ws, 'win32')).toBeNull();
    expect(toContainerPath('/home/me/proj/a', '/home/me/proj', 'linux')).toBe('/workspace/a');
    expect(toHostPath('/workspace/a/b', '/home/me/proj', 'linux')).toBe('/home/me/proj/a/b');
  });

  it('names containers and volumes safely', () => {
    expect(containerName('2f1c9a7e-1b2c-4d3e-8f90-a1b2c3d4e5f6')).toBe('graft-2f1c9a7e-1b2c-4d3e-8f90-a1b2c3d4e5f6');
    expect(containerName('a/b c')).toBe('graft-abc');
    expect(nodeModulesVolume('C:\\Proj')).toMatch(/^graft-node-modules-[a-f0-9]{16}$/);
    // The same folder spelled with another case on Windows shares the volume.
    expect(nodeModulesVolume('C:\\Proj')).toBe(nodeModulesVolume('c:\\proj'));
  });

  it('only accepts image names that cannot pass for a flag', () => {
    expect(IMAGE_PATTERN.test('node:22-bookworm')).toBe(true);
    expect(IMAGE_PATTERN.test('ghcr.io/owner/image:tag')).toBe(true);
    expect(IMAGE_PATTERN.test('registry.local:5000/team/app@sha256:abc123')).toBe(true);
    expect(IMAGE_PATTERN.test('--privileged')).toBe(false);
    expect(IMAGE_PATTERN.test('-v')).toBe(false);
    expect(IMAGE_PATTERN.test('node 22')).toBe(false);
    expect(IMAGE_PATTERN.test('')).toBe(false);
  });
});

describe('sandbox container arguments', () => {
  it('mounts only the project, with .git and .graft read-only, and keeps node_modules in a volume', () => {
    const args = runArgs(plan());
    const mounts = valuesOf(args, '--mount');
    expect(mounts).toEqual([
      'type=bind,source=C:\\Users\\me\\proj,target=/workspace',
      'type=bind,source=C:\\Users\\me\\proj\\.git,target=/workspace/.git,readonly',
      'type=bind,source=C:\\Users\\me\\proj\\.graft,target=/workspace/.graft,readonly',
      'type=bind,source=C:\\Users\\me\\AppData\\graft\\shell\\s1\\sandbox,target=/graft-state',
      `type=volume,source=${nodeModulesVolume('C:\\Users\\me\\proj')},target=/workspace/node_modules`
    ]);
    expect(args).toContain('--init');
    expect(valuesOf(args, '--security-opt')).toEqual(['no-new-privileges']);
    expect(valuesOf(args, '--pids-limit')).toEqual(['1024']);
    expect(valuesOf(args, '--memory')).toEqual(['4096m']);
    expect(valuesOf(args, '--label')).toEqual(['graft.app=graft', 'graft.session=s1']);
    // The image comes right after --entrypoint sh, then the keep-alive script.
    const at = args.indexOf('node:22-bookworm');
    expect(args.slice(at - 2, at)).toEqual(['--entrypoint', 'sh']);
    expect(args.slice(at + 1)).toEqual(['-c', expect.stringContaining('sleep 3600')]);
    // Never privileged, never the host's network or PID namespace.
    expect(args).not.toContain('--privileged');
    expect(args).not.toContain('--pid');
    expect(valuesOf(args, '--network')).not.toContain('host');
    expect(mounts.some((m) => m.includes('docker.sock'))).toBe(false);
  });

  it('forwards dev-server ports on localhost only, or cuts the network off entirely', () => {
    const on = runArgs(plan());
    expect(valuesOf(on, '--publish')).toEqual(FORWARDED_PORTS.map((p) => `127.0.0.1::${p}`));
    expect(on).not.toContain('--network');
    const off = runArgs(plan({ target: { ...plan().target, settings: { ...plan().target.settings, network: false } } }));
    expect(valuesOf(off, '--network')).toEqual(['none']);
    expect(off).not.toContain('--publish');
  });

  it('never asks for more CPUs than the engine has', () => {
    expect(valuesOf(runArgs(plan({ engine: { kind: 'docker', cpus: 1, rootless: false } })), '--cpus')).toEqual(['1']);
    expect(valuesOf(runArgs(plan()), '--cpus')).toEqual(['2']);
  });

  it('runs as the user on Linux with a rootful engine, so files in the project stay theirs', () => {
    const linux = plan({
      platform: 'linux',
      target: { ...plan().target, workspace: '/home/me/proj' },
      stateDir: '/home/me/.graft/s1',
      hostUser: { uid: 1000, gid: 1000 }
    });
    const rootful = runArgs(linux);
    expect(valuesOf(rootful, '--user')).toEqual(['1000:1000']);
    expect(valuesOf(rootful, '--env')).toContain('HOME=/tmp/home');
    // A fresh volume would belong to root; the user's own node_modules is used instead.
    expect(valuesOf(rootful, '--mount').some((m) => m.includes('node_modules'))).toBe(false);
    const rootless = runArgs({ ...linux, engine: { kind: 'podman', cpus: 4, rootless: true } });
    expect(rootless).not.toContain('--user');
  });

  it('quotes mount fields that contain a comma', () => {
    expect(mountValue([['type', 'bind'], ['source', 'C:\\a,b'], ['target', '/workspace'], 'readonly'])).toBe('type=bind,"source=C:\\a,b",target=/workspace,readonly');
  });

  it('passes the command through the environment, never in argv', () => {
    const args = execArgs('graft-s1', ['GRAFT_CMD', 'GRAFT_CWD'], SANDBOX_WRAPPER);
    expect(args.slice(0, 5)).toEqual(['exec', '--env', 'GRAFT_CMD', '--env', 'GRAFT_CWD']);
    expect(args).not.toContain('rm -rf /');
    // The wrapper keeps environment changes in the container, never handing them back.
    expect(SANDBOX_WRAPPER).toContain('export -p >');
    expect(SANDBOX_WRAPPER).not.toContain('env -0');
  });

  it('reads forwarded ports from docker port', () => {
    expect(parsePorts('5173/tcp -> 127.0.0.1:49153\n3000/tcp -> 127.0.0.1:49154\n3000/tcp -> [::1]:49155\n')).toEqual({ 5173: 49153, 3000: 49154 });
    expect(parsePorts('')).toEqual({});
  });
});

describe('container engine', () => {
  const pathDir = makeTempDir();
  const exe = process.platform === 'win32' ? '.exe' : '';
  writeFile(pathDir, `docker${exe}`, '');
  const env = { PATH: pathDir, Path: pathDir, PATHEXT: '.EXE' };

  it('reports a running engine with its CPUs', async () => {
    const run: Runner = () => Promise.resolve({ code: 0, stdout: '28.3.2|8|["name=seccomp,profile=builtin"]\n', stderr: '' });
    const probe = await probeEngine(process.platform, env, run);
    expect(probe).toMatchObject({ status: 'ready', engine: { kind: 'docker', version: '28.3.2', cpus: 8, rootless: false } });
  });

  it('tells someone to start Docker Desktop when it is installed but stopped', async () => {
    const run: Runner = () => Promise.resolve({ code: 1, stdout: '|0|', stderr: 'failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine' });
    const probe = await probeEngine(process.platform, env, run);
    expect(probe.status).toBe('stopped');
    expect(engineProblem(probe, 'win32')).toBe('Docker Desktop is installed but not running. Start Docker Desktop, then try again.');
    expect(engineProblem({ status: 'missing' }, 'linux')).toBe('The sandbox needs Docker or Podman. Install one of them, then try again.');
  });
});

describe('sandbox permissions', () => {
  const base: PermissionEnv = { mode: 'auto-edit', projectRoot: '/proj', platform: 'linux', home: '/home/me', rules: { allow: [], ask: [], deny: [] } };
  const shell = (command: string) => ({ toolName: 'Shell', permissionClass: 'exec' as const, descriptor: { summary: command, command } });

  it('runs sandboxed commands without asking in Auto-edit, but not in Ask mode', () => {
    expect(decide(shell('npm install'), base).behavior).toBe('ask');
    expect(decide(shell('npm install'), { ...base, sandboxed: true }).behavior).toBe('allow');
    expect(decide(shell('cat /etc/os-release && npm test'), { ...base, sandboxed: true }).behavior).toBe('allow');
    expect(decide(shell('npm install'), { ...base, mode: 'ask', sandboxed: true }).behavior).toBe('ask');
  });

  it('still asks before dangerous commands and still honors deny rules in the sandbox', () => {
    expect(decide(shell('rm -rf /workspace/src'), { ...base, sandboxed: true }).behavior).toBe('ask');
    const rule = parseRule('Shell(npm publish:*)', 'user');
    expect(rule).not.toBeNull();
    const denied: PermissionEnv = { ...base, sandboxed: true, rules: { allow: [], ask: [], deny: rule ? [rule] : [] } };
    expect(decide(shell('npm publish'), denied).behavior).toBe('deny');
  });
});

describe('sandbox system prompt', () => {
  const ctx: CodePromptContext = {
    model: { label: 'Model', id: 'model-1', provider: 'Provider' },
    cwd: 'C:\\proj',
    projectRoot: 'C:\\proj',
    platform: 'win32',
    shellLabel: 'Git Bash',
    git: { isRepo: true, branch: 'main' },
    date: '2026-10-03',
    mode: 'auto-edit',
    memory: [],
    skills: [],
    webSearch: false,
    mcpServers: []
  };

  it('tells the agent where commands run and how paths map', () => {
    const plain = buildCodeSystemPrompt(ctx);
    expect(plain).toContain('the Shell tool runs Git Bash');
    expect(plain).not.toContain('# Sandbox');
    const boxed = buildCodeSystemPrompt({ ...ctx, sandbox: { image: 'node:22-bookworm', network: false, ports: [5173] } });
    expect(boxed).toContain('the Shell tool runs bash in a Linux sandbox');
    expect(boxed).toContain('/workspace/src/app.ts in a command is C:\\proj\\src\\app.ts');
    expect(boxed).toContain('no network at all');
    // Port forwarding needs the network.
    expect(boxed).not.toContain('Ports 5173 are forwarded');
    expect(buildCodeSystemPrompt({ ...ctx, sandbox: { image: 'node:22-bookworm', network: true, ports: [5173] } })).toContain('Ports 5173 are forwarded');
  });
});
