import fs from 'node:fs';
import path from 'node:path';
import { GraftError } from '@shared/errors';
import { McpServerConfigSchema, McpServerNameSchema, type McpServerConfig, type SettingsScope } from '@shared/schemas/config';
import { McpServerInputSchema, type McpServerInput } from '@shared/schemas/customize';
import { looksSecret } from './mcpManager';
import { SECRET_REF, secretId } from './mcpConfig';
import { parseToml } from './tomlSubset';

/**
 * MCP servers other coding tools have set up, found in their settings files
 * so Customize can offer to add them to Graft. Those files are only read:
 * nothing is written to them and nothing is started here. A server from a
 * project's file is kept for this computer in that project (it runs once the
 * project is trusted); one from the user's own files, for all projects.
 */

export interface FoundServer {
  /** Stable while the file stays as it is: the file's key and the server's name. */
  id: string;
  name: string;
  /** The file it was found in, with ~ for the home folder. */
  from: string;
  scope: SettingsScope;
  config: McpServerConfig;
  /** Variables its settings name that this computer doesn't set: their text is kept as written. */
  missing: string[];
}

export interface ImportScan {
  servers: FoundServer[];
  /** A file that couldn't be read, or a server in one that can't be used: a sentence each. */
  problems: string[];
}

interface Source {
  key: string;
  file: string;
  scope: SettingsScope;
  /** The servers by name, from the file's text. */
  servers(text: string): unknown;
}

/** ~/.claude.json lists everything its tool remembers: it is read when it is no larger than this. */
const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** `${NAME}`, `${NAME:-fallback}` and `${env:NAME}`: a variable of this computer, as the other tools fill them in. */
const VARIABLE = /\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function strings(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(record(value) ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const norm = (p: string): string => {
    const resolved = (platform === 'win32' ? path.win32 : path.posix).resolve(p).replace(/[\\/]+$/, '');
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
}

/** The settings file of the other tool's desktop app on this system. */
function desktopConfig(home: string, platform: NodeJS.Platform): string {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  // rocky: on Windows APPDATA is taken as <home>\AppData\Roaming; a redirected roaming folder (some company PCs) is not looked in.
  if (platform === 'win32') return path.join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json');
  return path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
}

function sources(home: string, projectRoot: string | null, platform: NodeJS.Platform): Source[] {
  const json = (text: string): unknown => JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  const mcpServers = (text: string): unknown => record(json(text))?.mcpServers;
  const claudeJson = path.join(home, '.claude.json');
  // The project's own files come first: of two servers with one name, the first found is offered.
  const project: Source[] = projectRoot
    ? [
        { key: 'project', file: path.join(projectRoot, '.mcp.json'), scope: 'local', servers: mcpServers },
        { key: 'project-cursor', file: path.join(projectRoot, '.cursor', 'mcp.json'), scope: 'local', servers: mcpServers },
        {
          key: 'claude-project',
          file: claudeJson,
          scope: 'local',
          servers: (text) => {
            const projects = record(record(json(text))?.projects) ?? {};
            const entry = Object.entries(projects).find(([folder]) => samePath(folder, projectRoot, platform));
            return record(entry?.[1])?.mcpServers;
          }
        }
      ]
    : [];
  return [
    ...project,
    { key: 'claude', file: claudeJson, scope: 'user', servers: mcpServers },
    { key: 'desktop', file: desktopConfig(home, platform), scope: 'user', servers: mcpServers },
    { key: 'cursor', file: path.join(home, '.cursor', 'mcp.json'), scope: 'user', servers: mcpServers },
    { key: 'codex', file: path.join(home, '.codex', 'config.toml'), scope: 'user', servers: (text) => parseToml(text).mcp_servers }
  ];
}

/**
 * One server's settings as Graft's. The other tools write a local server as a
 * command with arguments and variables, and a remote one as an address with
 * headers; one names a token's variable instead (bearer_token_env_var).
 * Returns a sentence when the entry can't be used.
 */
function toConfig(raw: unknown, env: NodeJS.ProcessEnv): { config: McpServerConfig; missing: string[] } | string {
  const entry = record(raw);
  if (!entry) return 'it is not a server entry';
  const missing = new Set<string>();
  const fill = (text: string): string =>
    text.replace(VARIABLE, (whole: string, name: string, fallback: string | undefined) => {
      const value = env[name] ?? fallback;
      if (value === undefined) missing.add(name);
      return value ?? whole;
    });
  const fillAll = (values: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(values).map(([k, v]) => [k, fill(v)]));
  /** A variable of this computer the settings name outright (env_vars, bearer_token_env_var). */
  const variable = (name: string): string | undefined => {
    if (env[name] === undefined) missing.add(name);
    return env[name];
  };
  const enabled = entry.enabled !== false && entry.disabled !== true;
  const type = typeof entry.type === 'string' ? entry.type.toLowerCase() : null;
  let candidate: unknown;
  if (typeof entry.url === 'string' || (type !== null && type !== 'stdio')) {
    if (typeof entry.url !== 'string') return 'it has no address';
    const headers = { ...fillAll(strings(entry.headers)), ...fillAll(strings(entry.http_headers)) };
    for (const [header, name] of Object.entries(strings(entry.env_http_headers))) {
      const value = variable(name);
      if (value !== undefined) headers[header] = value;
    }
    const token = typeof entry.bearer_token_env_var === 'string' ? variable(entry.bearer_token_env_var) : undefined;
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;
    candidate = { type: 'http', url: fill(entry.url), headers, enabled };
  } else if (typeof entry.command === 'string' && entry.command.trim().length > 0) {
    const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === 'string').map(fill) : [];
    const cwd = typeof entry.cwd === 'string' ? fill(entry.cwd) : null;
    const passed: Record<string, string> = {};
    for (const name of Array.isArray(entry.env_vars) ? entry.env_vars : []) {
      const value = typeof name === 'string' ? variable(name) : undefined;
      if (typeof name === 'string' && value !== undefined) passed[name] = value;
    }
    candidate = { type: 'stdio', command: fill(entry.command), args, env: { ...passed, ...fillAll(strings(entry.env)) }, ...(cwd ? { cwd } : {}), inherit: 'no-secrets', enabled };
  } else {
    return 'it has neither a command nor an address';
  }
  const parsed = McpServerConfigSchema.safeParse(candidate);
  if (!parsed.success) return parsed.error.issues[0]?.path[0] === 'url' ? 'its address is not an http(s) address' : 'its settings are not ones Graft can use';
  return { config: parsed.data, missing: [...missing].sort() };
}

/** A name Graft can use: letters, digits, "-" and "_". */
function graftName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

/** Every server the other tools' settings files name, the project's first; the first of two with one name is the one offered. */
export function findImports(options: { home: string; projectRoot: string | null; platform: NodeJS.Platform; env: NodeJS.ProcessEnv }): ImportScan {
  const servers: FoundServer[] = [];
  const problems: string[] = [];
  const texts = new Map<string, string | null>();
  /** A file as the user knows it: from the project, else from the home folder (~). */
  const shown = (file: string): string => {
    for (const [base, prefix] of [[options.projectRoot, ''], [options.home, '~/']] as const) {
      const relative = base ? path.relative(base, file) : '..';
      if (!relative.startsWith('..') && !path.isAbsolute(relative)) return `${prefix}${relative.split(path.sep).join('/')}`;
    }
    return file;
  };
  const read = (file: string): string | null => {
    if (texts.has(file)) return texts.get(file) ?? null;
    let text: string | null = null;
    try {
      if (fs.statSync(file).size > MAX_FILE_BYTES) problems.push(`${shown(file)} is too large to read for servers.`);
      else text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') problems.push(`Couldn't read ${shown(file)}: ${(error as Error).message}`);
    }
    texts.set(file, text);
    return text;
  };
  for (const source of sources(options.home, options.projectRoot, options.platform)) {
    const text = read(source.file);
    if (text === null) continue;
    let listed: Record<string, unknown> | null;
    try {
      listed = record(source.servers(text));
    } catch (error) {
      // The same file is read for two lists (~/.claude.json): its problem is said once.
      const problem = `${shown(source.file)} couldn't be read: ${(error as Error).message}`;
      if (!problems.includes(problem)) problems.push(problem);
      continue;
    }
    for (const [written, raw] of Object.entries(listed ?? {})) {
      const name = graftName(written);
      const from = shown(source.file);
      const converted = toConfig(raw, options.env);
      if (typeof converted === 'string' || !McpServerNameSchema.safeParse(name).success) {
        problems.push(`"${written}" in ${from} can't be added: ${typeof converted === 'string' ? converted : 'its name has no letters or digits'}.`);
        continue;
      }
      if (servers.some((s) => s.name === name)) continue;
      servers.push({ id: `${source.key}:${name}`, name, from, scope: source.scope, ...converted });
    }
  }
  return { servers, problems };
}

/**
 * What Customize saves for a found server (through the same path as a server
 * added by hand), with each variable or header that looks like a key, a token
 * or a password moved to the key store: `secrets` holds them by key-store id,
 * and the settings file only refers to them. `key` is the server's key
 * (mcpConfig.serverKey) in the scope it is saved in.
 */
export function importInput(server: FoundServer, key: string): { input: McpServerInput; secrets: Record<string, string> } {
  const secrets: Record<string, string> = {};
  const stored = (values: Record<string, string>): Record<string, string> =>
    Object.fromEntries(
      Object.entries(values).map(([name, value]) => {
        if (!looksSecret(name, value)) return [name, value];
        const ref = secretId(key, name);
        secrets[ref] = value;
        return [name, `${SECRET_REF}${ref}`];
      })
    );
  const c = server.config;
  const input =
    c.type === 'stdio'
      ? { type: 'stdio', command: c.command, args: c.args, env: stored(c.env), keepEnv: [], cwd: c.cwd ?? null, inherit: c.inherit ?? 'no-secrets', enabled: c.enabled }
      : { type: 'http', url: c.url, headers: stored(c.headers), keepHeaders: [], enabled: c.enabled };
  const parsed = McpServerInputSchema.safeParse(input);
  if (!parsed.success) throw new GraftError('mcp_import_invalid', `${server.name} from ${server.from} has settings Graft can't save: ${parsed.error.issues[0]?.message ?? 'they are not valid'}.`);
  return { input: parsed.data, secrets };
}
