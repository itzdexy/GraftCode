import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serverKey } from '../../src/main/mcp/mcpConfig';
import { findImports, importInput } from '../../src/main/mcp/mcpImport';
import { parseToml } from '../../src/main/mcp/tomlSubset';
import { makeTempDir, removeDir, writeFile } from '../support/tmp';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(removeDir));

function temp(): string {
  const dir = makeTempDir();
  dirs.push(dir);
  return dir;
}

const json = (value: unknown): string => JSON.stringify(value, null, 2);

describe('the TOML subset', () => {
  it('reads tables, dotted and quoted keys, strings, arrays over lines, inline tables and arrays of tables', () => {
    const parsed = parseToml(
      [
        '# Settings',
        'model = "o4" # a comment',
        '',
        '[mcp_servers.docs]',
        'command = "npx"',
        'args = [',
        '  "-y", # the package follows',
        "  '@example/docs-mcp',",
        ']',
        'env = { "API_TOKEN" = "abc\\u0031\\"q\\"", MODE = \'raw\\n\' }',
        'startup_timeout_sec = 1_000',
        'enabled = false',
        '',
        '[mcp_servers."my server".env]',
        'PATH_EXTRA = """',
        'two',
        'lines"""',
        'when = 1979-05-27 07:32:00Z',
        '',
        '[[profiles]]',
        'name = "a"',
        '[[profiles]]',
        'name = "b"',
        'nested.deep.key = true'
      ].join('\r\n')
    );
    expect(parsed.model).toBe('o4');
    expect(parsed.mcp_servers).toEqual({
      docs: { command: 'npx', args: ['-y', '@example/docs-mcp'], env: { API_TOKEN: 'abc1"q"', MODE: 'raw\\n' }, startup_timeout_sec: 1000, enabled: false },
      'my server': { env: { PATH_EXTRA: 'two\r\nlines', when: '1979-05-27 07:32:00Z' } }
    });
    expect(parsed.profiles).toEqual([{ name: 'a' }, { name: 'b', nested: { deep: { key: true } } }]);
  });

  it('says on which line a file is malformed, and a key named __proto__ is only a key', () => {
    expect(() => parseToml('[mcp_servers.a]\ncommand = "npx\nargs = []')).toThrow(/line 2/);
    expect(() => parseToml('a = [1, 2')).toThrow(/line 1/);
    expect(() => parseToml('a = 1 b = 2')).toThrow(/end of the line/);
    const parsed = parseToml('[__proto__]\npolluted = true');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(parsed.__proto__).toEqual({ polluted: true });
  });
});

describe('MCP servers in other tools’ settings', () => {
  it('finds them in every format, the project’s first, and the first of two with one name wins', () => {
    const home = temp();
    const project = temp();
    writeFile(project, '.mcp.json', json({ mcpServers: { github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: '${GH_TOKEN}' } }, docs: { type: 'http', url: 'https://docs.example.com/mcp', headers: { Authorization: 'Bearer ${DOCS_KEY:-none}' } } } }));
    writeFile(project, '.cursor/mcp.json', json({ mcpServers: { linear: { url: 'https://mcp.linear.app/sse' }, github: { command: 'other' } } }));
    // Per project in ~/.claude.json, keyed by the folder however it was written.
    const written = process.platform === 'win32' ? project.toUpperCase().replace(/\\/g, '/') : project;
    writeFile(home, '.claude.json', json({ mcpServers: { memory: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] } }, projects: { [written]: { mcpServers: { local: { command: 'node', args: ['server.js'], cwd: '${HOME_DIR}' } } }, '/elsewhere': { mcpServers: { other: { command: 'x' } } } } }));
    const desktop = process.platform === 'win32' ? 'AppData/Roaming/Claude' : process.platform === 'darwin' ? 'Library/Application Support/Claude' : '.config/Claude';
    writeFile(home, `${desktop}/claude_desktop_config.json`, json({ mcpServers: { files: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] } } }));
    writeFile(home, '.cursor/mcp.json', json({ mcpServers: { 'my server!': { command: 'uvx', args: ['thing'], disabled: true } } }));
    writeFile(
      home,
      '.codex/config.toml',
      ['[mcp_servers.search]', 'command = "npx"', 'args = ["-y", "search-mcp"]', 'env_vars = ["SEARCH_KEY"]', '', '[mcp_servers.remote]', 'url = "https://remote.example.com/mcp"', 'bearer_token_env_var = "REMOTE_TOKEN"'].join('\n')
    );

    const scan = findImports({ home, projectRoot: project, platform: process.platform, env: { GH_TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', SEARCH_KEY: 'k-123', HOME_DIR: '/home/me' } });
    expect(scan.problems).toEqual([]);
    expect(scan.servers.map((s) => [s.id, s.from, s.scope])).toEqual([
      ['project:github', '.mcp.json', 'local'],
      ['project:docs', '.mcp.json', 'local'],
      ['project-cursor:linear', '.cursor/mcp.json', 'local'],
      ['claude-project:local', '~/.claude.json', 'local'],
      ['claude:memory', '~/.claude.json', 'user'],
      [`desktop:files`, `~/${desktop}/claude_desktop_config.json`, 'user'],
      ['cursor:my-server', '~/.cursor/mcp.json', 'user'],
      ['codex:search', '~/.codex/config.toml', 'user'],
      ['codex:remote', '~/.codex/config.toml', 'user']
    ]);
    const byName = Object.fromEntries(scan.servers.map((s) => [s.name, s]));
    expect(byName.github?.config).toMatchObject({ type: 'stdio', command: 'npx', env: { GITHUB_TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' } });
    expect(byName.docs?.config).toEqual({ type: 'http', url: 'https://docs.example.com/mcp', headers: { Authorization: 'Bearer none' }, enabled: true });
    expect(byName.local?.config).toMatchObject({ command: 'node', cwd: '/home/me' });
    expect(byName['my-server']?.config.enabled).toBe(false);
    expect(byName.search?.config).toMatchObject({ env: { SEARCH_KEY: 'k-123' } });
    // A variable this computer doesn't set is named, and its text stays as written.
    expect(byName.remote?.missing).toEqual(['REMOTE_TOKEN']);
    expect(byName.remote?.config).toMatchObject({ type: 'http', headers: {} });
  });

  it('reads only the home folder’s files without a project', () => {
    const home = temp();
    writeFile(home, '.claude.json', json({ mcpServers: { memory: { command: 'npx' } }, projects: { '/p': { mcpServers: { local: { command: 'node' } } } } }));
    expect(findImports({ home, projectRoot: null, platform: process.platform, env: {} }).servers.map((s) => s.id)).toEqual(['claude:memory']);
  });

  it('passes over missing files, and names a malformed file or an entry it can’t use', () => {
    const home = temp();
    const project = temp();
    writeFile(project, '.mcp.json', '{ "mcpServers": { "a": ');
    writeFile(home, '.codex/config.toml', '[mcp_servers.a]\ncommand = "npx\n');
    writeFile(home, '.cursor/mcp.json', json({ mcpServers: { nothing: { args: [] }, ws: { url: 'ws://example.com' }, '!!!': { command: 'x' }, fine: { command: 'ok' } } }));
    const scan = findImports({ home, projectRoot: project, platform: process.platform, env: {} });
    expect(scan.servers.map((s) => s.name)).toEqual(['fine']);
    expect(scan.problems).toHaveLength(5);
    expect(scan.problems[0]).toMatch(/^\.mcp\.json couldn't be read: /);
    expect(scan.problems).toContain('"nothing" in ~/.cursor/mcp.json can\'t be added: it has neither a command nor an address.');
    expect(scan.problems).toContain('"ws" in ~/.cursor/mcp.json can\'t be added: its address is not an http(s) address.');
    expect(scan.problems).toContain('"!!!" in ~/.cursor/mcp.json can\'t be added: its name has no letters or digits.');
    expect(scan.problems.at(-1)).toMatch(/^~\/\.codex\/config\.toml couldn't be read: line 2/);
  });

  it('moves values that look like keys to the key store, and keeps the others in the settings', () => {
    const home = temp();
    writeFile(
      home,
      '.claude.json',
      json({
        mcpServers: {
          github: { command: 'npx', args: ['-y', 'gh-mcp'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'abc', LOG_LEVEL: 'debug', DATABASE_URL: 'postgres://admin:hunter22@db/x', OTHER: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456' } },
          docs: { url: 'https://docs.example.com/mcp', headers: { 'X-Api-Key': 'plain-looking', Accept: 'application/json' } }
        }
      })
    );
    const [github, docs] = findImports({ home, projectRoot: null, platform: process.platform, env: {} }).servers;
    const key = serverKey('user', null, 'github');
    const stdio = importInput(github!, key);
    expect(stdio.input).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'gh-mcp'],
      env: {
        GITHUB_PERSONAL_ACCESS_TOKEN: `graft-secret:mcp-secret:${key}:GITHUB_PERSONAL_ACCESS_TOKEN`,
        LOG_LEVEL: 'debug',
        DATABASE_URL: `graft-secret:mcp-secret:${key}:DATABASE_URL`,
        OTHER: `graft-secret:mcp-secret:${key}:OTHER`
      },
      keepEnv: [],
      cwd: null,
      inherit: 'no-secrets',
      enabled: true
    });
    expect(stdio.secrets).toEqual({
      [`mcp-secret:${key}:GITHUB_PERSONAL_ACCESS_TOKEN`]: 'abc',
      [`mcp-secret:${key}:DATABASE_URL`]: 'postgres://admin:hunter22@db/x',
      [`mcp-secret:${key}:OTHER`]: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456'
    });
    const http = importInput(docs!, serverKey('user', null, 'docs'));
    expect(http.input).toMatchObject({ type: 'http', headers: { 'X-Api-Key': expect.stringMatching(/^graft-secret:/) as unknown, Accept: 'application/json' } });
    expect(Object.values(http.secrets)).toEqual(['plain-looking']);
  });

  it('keeps a project server for this computer in that project, matched by its folder', () => {
    const home = temp();
    const project = temp();
    writeFile(project, '.mcp.json', json({ mcpServers: { tool: { command: 'node', args: [path.join(project, 'tool.js')] } } }));
    const [found] = findImports({ home, projectRoot: project, platform: process.platform, env: {} }).servers;
    expect(found?.scope).toBe('local');
    expect(importInput(found!, serverKey('local', project, 'tool')).input).toMatchObject({ type: 'stdio', command: 'node' });
  });
});
