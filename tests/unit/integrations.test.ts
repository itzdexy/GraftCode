import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { INTEGRATION_CATEGORIES, INTEGRATIONS } from '../../src/shared/integrations';
import { findCommand, integrationSetup, integrationStatus } from '../../src/main/mcp/integrations';
import { resolveSecrets, secretId, secretRefs, serverKey } from '../../src/main/mcp/mcpConfig';

const sep = path.delimiter;
const files = (list: string[]) => (file: string) => list.includes(file);

describe('finding runtimes', () => {
  it('looks on PATH with the platform’s extensions, then in the usual install folders', () => {
    const bin = path.join('C:', 'tools', 'bin');
    const uvx = path.join(bin, 'uvx.EXE');
    const env = { PATH: [path.join('C:', 'nothing'), bin].join(sep), PATHEXT: '.COM;.EXE;.CMD', USERPROFILE: path.join('C:', 'Users', 'ada') };
    expect(findCommand('uvx', 'win32', env, files([uvx]))).toBe(uvx);
    // Installed after the app started: not on its PATH yet, but in ~/.local/bin.
    const local = path.join('C:', 'Users', 'ada', '.local', 'bin', 'uvx.EXE');
    expect(findCommand('uvx', 'win32', { ...env, PATH: '' }, files([local]))).toBe(local);
    expect(findCommand('npx', 'win32', env, files([]))).toBeNull();
    expect(findCommand('npx', 'freebsd', env, files([]))).toBeNull();
  });
});

describe('integrations', () => {
  const winEnv = { PATH: '', PATHEXT: '.EXE;.CMD', USERPROFILE: path.join('C:', 'Users', 'ada'), LOCALAPPDATA: path.join('C:', 'Users', 'ada', 'AppData', 'Local') };

  it('every preset has a launch for at least one platform, steps and an https docs link', () => {
    for (const i of INTEGRATIONS) {
      expect(Object.keys(i.launch).length, i.id).toBeGreaterThan(0);
      expect(i.steps.length, i.id).toBeGreaterThan(0);
      expect(i.docs, i.id).toMatch(/^https:\/\//);
      expect(i.serverName, i.id).toMatch(/^[a-z0-9_-]+$/);
    }
    expect(new Set(INTEGRATIONS.map((i) => i.serverName)).size).toBe(INTEGRATIONS.length);
  });

  it('says what each one still needs: the OS, a runtime or the other app', () => {
    const status = Object.fromEntries(integrationStatus('win32', winEnv, files([])).map((s) => [s.id, s.blocker]));
    expect(status.blender).toEqual({ kind: 'runtime', runtime: 'uv' });
    expect(status.godot).toEqual({ kind: 'runtime', runtime: 'node' });
    expect(status['roblox-studio']).toEqual({ kind: 'app', path: `${winEnv.LOCALAPPDATA}\\Roblox\\mcp.bat` });
    expect(status.github).toBeNull();
    const linux = Object.fromEntries(integrationStatus('linux', { PATH: '' }, files([])).map((s) => [s.id, s.blocker]));
    expect(linux['roblox-studio']).toEqual({ kind: 'platform' });
    expect(linux.figma).toEqual({ kind: 'platform' });
  });

  it('builds a stdio server from the preset, using a runtime found outside PATH by its full path', () => {
    const uvx = path.join(winEnv.USERPROFILE, '.local', 'bin', 'uvx.EXE');
    const blender = integrationSetup('blender', {}, 'win32', winEnv, files([uvx]));
    expect(blender).toEqual({
      name: 'blender',
      config: { type: 'stdio', command: uvx, args: ['mcp-for-blender'], env: {}, keepEnv: [], cwd: null, enabled: true },
      secrets: {}
    });
    const roblox = integrationSetup('roblox-studio', {}, 'win32', winEnv, files([]));
    expect(roblox.config).toMatchObject({ type: 'stdio', command: 'cmd.exe', args: ['/c', `${winEnv.LOCALAPPDATA}\\Roblox\\mcp.bat`] });
    const godot = integrationSetup('godot', { GODOT_PATH: '  C:\\Godot\\godot.exe ' }, 'linux', { PATH: '' }, files([]));
    expect(godot.config).toMatchObject({ type: 'stdio', command: 'npx', args: ['-y', '@coding-solo/godot-mcp'], env: { GODOT_PATH: 'C:\\Godot\\godot.exe' } });
  });

  it('sets Ghidra up for reverse engineering: the documented server, with the folder Ghidra is installed in', () => {
    const ghidra = INTEGRATIONS.find((i) => i.id === 'ghidra')!;
    expect(ghidra.category).toBe('Reverse engineering');
    expect(INTEGRATION_CATEGORIES).toContain('Reverse engineering');
    const status = Object.fromEntries(integrationStatus('win32', winEnv, files([])).map((s) => [s.id, s.blocker]));
    expect(status.ghidra).toEqual({ kind: 'runtime', runtime: 'uv' });
    const uvx = path.join(winEnv.USERPROFILE, '.local', 'bin', 'uvx.EXE');
    const setup = integrationSetup('ghidra', { GHIDRA_INSTALL_DIR: ' C:\\ghidra ' }, 'win32', winEnv, files([uvx]));
    // The launch its own documentation gives: uvx pyghidra-mcp --transport stdio, with GHIDRA_INSTALL_DIR set.
    expect(setup.config).toEqual({ type: 'stdio', command: uvx, args: ['pyghidra-mcp', '--transport', 'stdio'], env: { GHIDRA_INSTALL_DIR: 'C:\\ghidra' }, keepEnv: [], cwd: null, enabled: true });
    expect(setup.secrets).toEqual({});
    expect(() => integrationSetup('ghidra', {}, 'linux', { PATH: '' }, files([]))).toThrow(/Enter the ghidra folder first/);
  });

  it('keeps tokens in the key store and only a reference to them in the settings', () => {
    const github = integrationSetup('github', { token: 'github_pat_secret' }, 'darwin', { PATH: '' }, files([]));
    const ref = secretId(serverKey('user', null, 'github'), 'Authorization');
    expect(github.config).toEqual({ type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: `graft-secret:${ref}` }, keepHeaders: [], enabled: true });
    expect(github.secrets).toEqual({ [ref]: 'Bearer github_pat_secret' });
    expect(JSON.stringify(github.config)).not.toContain('github_pat_secret');
    expect(() => integrationSetup('github', { token: '  ' }, 'darwin', { PATH: '' }, files([]))).toThrow(/Enter the personal access token first/);
    // An optional key left empty adds no header.
    expect(integrationSetup('context7', {}, 'linux', { PATH: '' }, files([])).config).toMatchObject({ headers: {} });
    expect(() => integrationSetup('roblox-studio', {}, 'linux', { PATH: '' }, files([]))).toThrow(/isn’t available/);
    expect(() => integrationSetup('nope', {}, 'linux', { PATH: '' }, files([]))).toThrow(/doesn’t exist/);
  });

  it('resolves a secret reference only for the server it belongs to', () => {
    const key = serverKey('user', null, 'github');
    const ref = secretId(key, 'Authorization');
    const store = new Map([[ref, 'Bearer abc'], ['provider:openai', 'sk-live']]);
    const get = (id: string) => store.get(id) ?? null;
    expect(resolveSecrets({ Authorization: `graft-secret:${ref}`, Accept: 'json' }, key, get)).toEqual({ Authorization: 'Bearer abc', Accept: 'json' });
    // A project server pointing at the user's token, or at a provider key, gets nothing.
    const other = serverKey('project', '/repo', 'github');
    expect(() => resolveSecrets({ Authorization: `graft-secret:${ref}` }, other, get)).toThrow(/belongs to another server/);
    expect(() => resolveSecrets({ X: 'graft-secret:provider:openai' }, key, get)).toThrow(/belongs to another server/);
    expect(() => resolveSecrets({ Authorization: `graft-secret:${secretId(key, 'Gone')}` }, key, get)).toThrow(/missing/);
    expect(secretRefs({ type: 'http', url: 'https://x.example/mcp', headers: { Authorization: `graft-secret:${ref}`, A: 'b' }, enabled: true })).toEqual([ref]);
  });
});
