import { createHash } from 'node:crypto';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { ErrorCode, McpError, ToolListChangedNotificationSchema, type Progress } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { McpServerConfig, SettingsScope } from '@shared/schemas/config';
import type { ImageBlock, ToolResultContent } from '@shared/schemas/messages';
import { GraftError } from '@shared/errors';
import { INTEGRATIONS } from '@shared/integrations';
import type { McpToolSource } from '../agent/sessionManager';
import type { SettingsStore } from '../permissions/settingsStore';
import type { KeyStore } from '../secrets/keyStore';
import type { ToolRegistry } from '../tools/registry';
import type { ToolDefinition } from '../tools/types';
import { findCommand, searchDirs } from './integrations';
import { resolveSecrets, serverKey } from './mcpConfig';
import { McpOAuthProvider, startOAuthCallback } from './oauth';

const CONNECT_TIMEOUT_MS = 30_000;
/** How long a call may go without an answer or a progress report. */
const CALL_TIMEOUT_MS = 120_000;
/** How long a call that keeps reporting progress may run in all. */
const CALL_MAX_MS = 15 * 60_000;
const MAX_RESULT_CHARS = 100_000;
const MAX_TOOL_PAGES = 50;
/** A server that connects without tools is asked again this often, this many times (some never announce them). */
const TOOL_POLL_MS = 20_000;
const TOOL_POLLS = 30;
/** Delays before reconnecting a server that closed by itself. */
const RECONNECT_DELAYS_MS = [2_000, 10_000, 30_000];

export type McpState = 'connecting' | 'connected' | 'failed' | 'disabled' | 'needs-auth';

export interface McpToolInfo {
  name: string;
  registeredAs: string;
  description: string;
  readOnly: boolean;
}

export interface McpServerStatus {
  name: string;
  scope: SettingsScope;
  projectRoot: string | null;
  transport: 'stdio' | 'http';
  state: McpState;
  error: string | null;
  /** What to do when the server is connected but offers nothing yet. */
  hint: string | null;
  tools: McpToolInfo[];
}

interface RemoteTool {
  name: string;
  description?: string | undefined;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean | undefined; destructiveHint?: boolean | undefined } | undefined;
}

/** Tool names must match ^[A-Za-z][A-Za-z0-9_]{0,63}$ for every provider. */
export function mcpToolName(server: string, tool: string): string {
  const clean = (s: string): string => s.replace(/[^A-Za-z0-9_]/g, '_');
  const full = `mcp__${clean(server)}__${clean(tool)}`;
  if (full.length <= 64) return full;
  const hash = createHash('sha256').update(`${server}/${tool}`).digest('hex').slice(0, 6);
  return `${full.slice(0, 57)}_${hash}`;
}

function configKey(config: McpServerConfig): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
}

/** Converts MCP tool results into provider-neutral content. */
export function convertContent(content: unknown, vision: boolean): ToolResultContent[] {
  const out: ToolResultContent[] = [];
  let chars = 0;
  for (const item of Array.isArray(content) ? (content as Array<Record<string, unknown>>) : []) {
    if (item.type === 'text' && typeof item.text === 'string') {
      const text = item.text.slice(0, Math.max(0, MAX_RESULT_CHARS - chars));
      chars += text.length;
      out.push({ type: 'text', text });
    } else if (item.type === 'image' && typeof item.data === 'string' && typeof item.mimeType === 'string') {
      const media = item.mimeType as ImageBlock['mediaType'];
      if (vision && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(media)) out.push({ type: 'image', mediaType: media, data: item.data });
      else out.push({ type: 'text', text: `[image ${item.mimeType} omitted]` });
    } else if (item.type === 'resource' && item.resource && typeof item.resource === 'object') {
      const r = item.resource as { uri?: string; text?: string };
      out.push({ type: 'text', text: r.text ? `${r.uri ?? 'resource'}:\n${r.text.slice(0, 20_000)}` : `[resource ${r.uri ?? ''}]` });
    } else if (item.type === 'resource_link' && typeof item.uri === 'string') {
      out.push({ type: 'text', text: `[resource link ${item.uri}]` });
    }
  }
  if (chars >= MAX_RESULT_CHARS) out.push({ type: 'text', text: '[output truncated]' });
  return out.length > 0 ? out : [{ type: 'text', text: '(no content)' }];
}

/** A progress report as one line for the running tool card. */
export function progressLine(p: Pick<Progress, 'progress' | 'total' | 'message'>): string {
  const share = p.total && p.total > 0 ? `${Math.round((p.progress / p.total) * 100)}%` : null;
  return `${[p.message, share].filter((s) => typeof s === 'string' && s.length > 0).join(' · ') || 'Working…'}\n`;
}

/** What to check for a server added from an integration (Blender, Roblox Studio…), if it is one. */
export function troubleshootFor(name: string): string | null {
  return INTEGRATIONS.find((i) => i.serverName === name)?.troubleshoot ?? null;
}

/**
 * The environment for a stdio server: this computer's, so `npx`, `uvx` and the
 * programs they start behave as in a terminal, with the folders runtimes
 * usually install into added to PATH (apps opened from the macOS Finder get a
 * short one), then the server's own variables.
 */
export function stdioEnv(base: NodeJS.ProcessEnv, extra: Record<string, string>, platform: NodeJS.Platform): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (typeof v === 'string') env[k] = v;
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const sep = platform === 'win32' ? ';' : ':';
  const current = (env[key] ?? '').split(sep).filter((d) => d.length > 0);
  const api = platform === 'win32' ? path.win32 : path.posix;
  const same = (a: string, b: string): boolean => (platform === 'win32' ? api.normalize(a).toLowerCase() === api.normalize(b).toLowerCase() : api.normalize(a) === api.normalize(b));
  const added = searchDirs(platform, base).filter((d) => !current.some((c) => same(c, d)));
  env[key] = [...current, ...added].join(sep);
  return { ...env, ...extra };
}

interface Connection {
  name: string;
  scope: SettingsScope;
  projectRoot: string | null;
  config: McpServerConfig;
  key: string;
  state: McpState;
  error: string | null;
  client: Client | null;
  transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport | null;
  tools: McpToolInfo[];
  /** Last lines a stdio server wrote to stderr (shown when it fails to start). */
  stderr: string;
  /** Re-asks a server that connected without tools. */
  poll: NodeJS.Timeout | null;
  /** Reconnects after the server closed by itself. */
  retry: NodeJS.Timeout | null;
  retries: number;
  /** Set while Graft closes the connection on purpose, so the close isn't treated as a crash. */
  closing: boolean;
}

export interface McpManagerDeps {
  settings: SettingsStore;
  registry: ToolRegistry;
  keys: KeyStore;
  openBrowser: (url: string) => Promise<void>;
  log: (level: 'info' | 'warn', message: string, fields?: Record<string, string>) => void;
  onChange: () => void;
  /** Graft's version, reported to MCP servers. */
  version: string;
  /** Tests shorten the waits. */
  timings?: { toolPollMs?: number; reconnectDelaysMs?: number[] };
}

/**
 * Connects the MCP servers from settings files and registers their tools as
 * mcp__server__tool. User-scope servers connect at startup; project and local
 * servers connect when a session in that (trusted) project starts. Tool lists
 * follow the server: announced changes are picked up, a server that starts
 * empty is asked again, and one that crashes is reconnected.
 */
export class McpManager implements McpToolSource {
  private readonly connections = new Map<string, Connection>();
  private readonly projects = new Set<string>();

  constructor(private readonly deps: McpManagerDeps) {}

  /** Re-reads settings and brings connections in line with them. */
  async sync(): Promise<void> {
    const wanted = new Map<string, { name: string; scope: SettingsScope; projectRoot: string | null; config: McpServerConfig }>();
    for (const s of this.deps.settings.mcpServers(null, true)) wanted.set(s.name, { ...s, projectRoot: null });
    for (const root of this.projects) {
      for (const s of this.deps.settings.mcpServers(root, true)) {
        if (s.scope === 'user') continue;
        const existing = wanted.get(s.name);
        if (existing && existing.projectRoot !== root) continue;
        wanted.set(s.name, { ...s, projectRoot: root });
      }
    }
    for (const [name, conn] of this.connections) {
      const next = wanted.get(name);
      if (!next || configKey(next.config) !== conn.key || next.scope !== conn.scope || next.projectRoot !== conn.projectRoot) {
        await this.disconnect(conn);
        this.connections.delete(name);
      }
    }
    const pending: Array<Promise<void>> = [];
    for (const [name, w] of wanted) {
      if (this.connections.has(name)) continue;
      const conn: Connection = {
        ...w,
        key: configKey(w.config),
        state: 'connecting',
        error: null,
        client: null,
        transport: null,
        tools: [],
        stderr: '',
        poll: null,
        retry: null,
        retries: 0,
        closing: false
      };
      this.connections.set(name, conn);
      if (!w.config.enabled) {
        conn.state = 'disabled';
        continue;
      }
      pending.push(this.connect(conn));
    }
    this.deps.onChange();
    await Promise.all(pending);
  }

  /** Includes a trusted project's own servers (called when a session in it starts). */
  async useProject(root: string, trusted: boolean): Promise<void> {
    if (!trusted || this.projects.has(root)) return;
    this.projects.add(root);
    await this.sync();
  }

  private transportFor(conn: Connection, authProvider: McpOAuthProvider | null, legacy = false): StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport {
    const c = conn.config;
    const secret = (id: string): string | null => this.deps.keys.get(id);
    if (c.type === 'stdio') {
      // A bare command ("npx", "uvx") is looked up in the usual install folders too.
      const command = path.isAbsolute(c.command) ? c.command : (findCommand(c.command, process.platform, process.env) ?? c.command);
      return new StdioClientTransport({
        command,
        args: c.args,
        env: stdioEnv(process.env, resolveSecrets(c.env, this.serverKey(conn), secret), process.platform),
        ...(c.cwd ? { cwd: c.cwd } : conn.projectRoot ? { cwd: conn.projectRoot } : {}),
        stderr: 'pipe'
      });
    }
    const headers = resolveSecrets(c.headers, this.serverKey(conn), secret);
    if (legacy) return new SSEClientTransport(new URL(c.url), { requestInit: { headers }, ...(authProvider ? { authProvider } : {}) });
    return new StreamableHTTPClientTransport(new URL(c.url), { requestInit: { headers }, ...(authProvider ? { authProvider } : {}) });
  }

  private async connect(conn: Connection, authProvider: McpOAuthProvider | null = null): Promise<void> {
    conn.state = 'connecting';
    conn.error = null;
    conn.closing = false;
    this.deps.onChange();
    const auth = authProvider ?? this.storedAuth(conn);
    // HTTP servers get the current transport first, then the older SSE one that some still use.
    const attempts = conn.config.type === 'http' ? [false, true] : [false];
    for (const [i, legacy] of attempts.entries()) {
      const last = i === attempts.length - 1;
      const outcome = await this.attempt(conn, auth, legacy);
      if (outcome === 'ok' || outcome === 'auth' || last) break;
    }
    this.deps.onChange();
  }

  /** One connection attempt; 'retry' lets an HTTP server try the older transport. */
  private async attempt(conn: Connection, auth: McpOAuthProvider | null, legacy: boolean): Promise<'ok' | 'auth' | 'retry'> {
    let transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;
    try {
      transport = this.transportFor(conn, auth, legacy);
    } catch (error) {
      // A secret that is missing or belongs to another server: the server can't start.
      conn.state = 'failed';
      conn.error = (error as Error).message;
      return 'auth';
    }
    conn.stderr = '';
    if (transport instanceof StdioClientTransport) {
      transport.stderr?.on('data', (chunk: Buffer) => {
        conn.stderr = (conn.stderr + chunk.toString('utf8')).slice(-2000);
      });
    }
    const client = new Client({ name: 'graft', version: this.deps.version }, { capabilities: {} });
    // Set before connecting: a server may announce its tools right after the handshake.
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      void this.refreshTools(conn, client, 'changed');
    });
    try {
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `${conn.name} did not answer within 30 seconds.`);
      const tools = await listAllTools(client);
      conn.client = client;
      conn.transport = transport;
      this.registerTools(conn, tools);
      conn.state = 'connected';
      conn.retries = 0;
      client.onclose = () => this.onClosed(conn, client);
      if (tools.length === 0) this.watchForTools(conn, client);
      this.deps.log('info', 'MCP server connected', { server: conn.name, tools: String(conn.tools.length), ...(legacy ? { transport: 'sse' } : {}) });
      return 'ok';
    } catch (error) {
      await transport.close().catch((closeError: unknown) => this.deps.log('warn', 'MCP transport close failed', { server: conn.name, message: (closeError as Error).message }));
      if (error instanceof UnauthorizedError) {
        conn.state = 'needs-auth';
        conn.error = 'This server needs you to sign in.';
        return 'auth';
      }
      conn.state = 'failed';
      const tail = conn.stderr.trim().split(/\r?\n/).slice(-3).join(' ');
      const hint = troubleshootFor(conn.name);
      conn.error = [(error as Error).message, tail ? `(${tail})` : null, hint].filter((s): s is string => s !== null && s.length > 0).join(' ');
      this.deps.log('warn', 'MCP server failed to connect', { server: conn.name, message: conn.error, ...(legacy ? { transport: 'sse' } : {}) });
      return 'retry';
    }
  }

  /** Re-reads a server's tools after it announced a change (or while it still has none). */
  private async refreshTools(conn: Connection, client: Client, why: 'changed' | 'poll'): Promise<void> {
    if (conn.client !== client) return;
    try {
      const tools = await listAllTools(client);
      if (conn.client !== client) return;
      const before = conn.tools.length;
      this.registerTools(conn, tools);
      if (tools.length > 0) this.stopPolling(conn);
      if (tools.length !== before || why === 'changed') {
        this.deps.log('info', 'MCP tools updated', { server: conn.name, tools: String(tools.length), reason: why });
        this.deps.onChange();
      }
    } catch (error) {
      this.deps.log('warn', 'Could not refresh MCP tools', { server: conn.name, message: (error as Error).message });
    }
  }

  /**
   * A server connected without tools (Roblox Studio's proxy before Studio
   * attaches, for one). Most announce their tools when ready; ask again for a
   * while in case this one doesn't.
   */
  private watchForTools(conn: Connection, client: Client): void {
    this.stopPolling(conn);
    let polls = 0;
    const every = this.deps.timings?.toolPollMs ?? TOOL_POLL_MS;
    const tick = (): void => {
      conn.poll = null;
      if (conn.client !== client || conn.tools.length > 0 || polls++ >= TOOL_POLLS) return;
      void this.refreshTools(conn, client, 'poll').finally(() => {
        if (conn.client === client && conn.tools.length === 0 && polls < TOOL_POLLS) conn.poll = setTimeout(tick, every);
      });
    };
    conn.poll = setTimeout(tick, every);
  }

  private stopPolling(conn: Connection): void {
    if (conn.poll) clearTimeout(conn.poll);
    conn.poll = null;
  }

  /** The server went away without Graft closing it: reconnect a few times, then report it. */
  private onClosed(conn: Connection, client: Client): void {
    if (conn.client !== client || conn.closing) return;
    this.unregisterTools(conn);
    this.stopPolling(conn);
    conn.client = null;
    conn.transport = null;
    const delays = this.deps.timings?.reconnectDelaysMs ?? RECONNECT_DELAYS_MS;
    const delay = delays[conn.retries];
    if (delay === undefined) {
      conn.state = 'failed';
      const tail = conn.stderr.trim().split(/\r?\n/).slice(-2).join(' ');
      conn.error = `The server stopped and didn't come back.${tail ? ` (${tail})` : ''}`;
      this.deps.log('warn', 'MCP server stopped', { server: conn.name });
      this.deps.onChange();
      return;
    }
    conn.retries++;
    conn.state = 'connecting';
    conn.error = 'The server stopped; reconnecting…';
    this.deps.onChange();
    conn.retry = setTimeout(() => {
      conn.retry = null;
      if (this.connections.get(conn.name) !== conn || conn.closing) return;
      void this.connect(conn);
    }, delay);
  }

  /** HTTP servers that already have OAuth tokens reuse them. */
  private storedAuth(conn: Connection): McpOAuthProvider | null {
    if (conn.config.type !== 'http') return null;
    return new McpOAuthProvider(this.deps.keys, this.serverKey(conn), 'http://127.0.0.1/callback', this.deps.openBrowser);
  }

  private serverKey(conn: Connection): string {
    return serverKey(conn.scope, conn.projectRoot, conn.name);
  }

  private registerTools(conn: Connection, tools: RemoteTool[]): void {
    this.unregisterTools(conn);
    conn.tools = tools.map((tool) => {
      const registeredAs = mcpToolName(conn.name, tool.name);
      const readOnly = tool.annotations?.readOnlyHint === true;
      const destructive = tool.annotations?.destructiveHint === true;
      const definition: ToolDefinition<Record<string, unknown>> = {
        name: registeredAs,
        description: `${tool.description ?? tool.name} (from the ${conn.name} MCP server)`,
        input: z.record(z.string(), z.unknown()),
        jsonSchema: tool.inputSchema,
        permissionClass: readOnly ? 'read' : 'exec',
        mcp: { server: conn.name, tool: tool.name, readOnly, destructive },
        concurrencySafe: () => readOnly,
        timeoutMs: CALL_MAX_MS + 30_000,
        describe: (input) =>
          Promise.resolve({
            summary: `${conn.name} · ${tool.name}`,
            preview: { kind: 'mcp', server: conn.name, tool: tool.name, input: JSON.stringify(input, null, 2).slice(0, 4000) }
          }),
        execute: async (input, ctx) => {
          const client = conn.client;
          if (!client) {
            const hint = troubleshootFor(conn.name);
            throw new GraftError('mcp_disconnected', `The ${conn.name} MCP server is not connected.${hint ? ` ${hint}` : ''}`);
          }
          let result;
          try {
            result = await client.callTool({ name: tool.name, arguments: input }, undefined, {
              signal: ctx.signal,
              timeout: CALL_TIMEOUT_MS,
              // A long job that keeps reporting progress (a render, a download) isn't stuck.
              resetTimeoutOnProgress: true,
              maxTotalTimeout: CALL_MAX_MS,
              onprogress: (p) => ctx.progress(progressLine(p))
            });
          } catch (error) {
            if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
              const hint = troubleshootFor(conn.name);
              throw new GraftError('mcp_timeout', `${conn.name} didn't answer within ${Math.round(CALL_TIMEOUT_MS / 1000)} seconds.${hint ? ` ${hint}` : ''}`);
            }
            throw error;
          }
          const content = convertContent(result.content, ctx.modelSupportsVision);
          const text = content
            .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
            .map((c) => c.text)
            .join('\n');
          return { isError: result.isError === true, content, display: { kind: 'mcp', server: conn.name, tool: tool.name, text: text.slice(0, 4000) } };
        }
      };
      this.deps.registry.upsert(definition);
      return { name: tool.name, registeredAs, description: tool.description ?? '', readOnly };
    });
  }

  private unregisterTools(conn: Connection): void {
    for (const t of conn.tools) this.deps.registry.remove(t.registeredAs);
    conn.tools = [];
  }

  private async disconnect(conn: Connection): Promise<void> {
    conn.closing = true;
    this.stopPolling(conn);
    if (conn.retry) clearTimeout(conn.retry);
    conn.retry = null;
    this.unregisterTools(conn);
    const client = conn.client;
    conn.client = null;
    conn.transport = null;
    if (client) {
      await client.close().catch((error: unknown) => this.deps.log('warn', 'MCP close failed', { server: conn.name, message: (error as Error).message }));
    }
  }

  /** Starts the browser sign-in for an HTTP server that requires OAuth, then reconnects. */
  async authorize(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) throw new GraftError('mcp_unknown', `No MCP server named ${name}.`);
    if (conn.config.type !== 'http') throw new GraftError('mcp_no_auth', 'Only HTTP servers use sign-in.');
    const callback = await startOAuthCallback();
    try {
      const provider = new McpOAuthProvider(this.deps.keys, this.serverKey(conn), callback.url, this.deps.openBrowser);
      const transport = this.transportFor(conn, provider) as StreamableHTTPClientTransport;
      const client = new Client({ name: 'graft', version: this.deps.version }, { capabilities: {} });
      try {
        await client.connect(transport);
        // Already authorized (tokens were refreshed): use this connection.
        await client.close();
      } catch (error) {
        if (!(error instanceof UnauthorizedError)) throw error;
        await transport.finishAuth(await callback.code);
      }
      await this.disconnect(conn);
      await this.connect(conn, provider);
    } finally {
      callback.close();
    }
  }

  async reconnect(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) throw new GraftError('mcp_unknown', `No MCP server named ${name}.`);
    await this.disconnect(conn);
    conn.retries = 0;
    if (!conn.config.enabled) {
      conn.state = 'disabled';
      this.deps.onChange();
      return;
    }
    await this.connect(conn);
  }

  status(): McpServerStatus[] {
    return [...this.connections.values()].map((c) => ({
      name: c.name,
      scope: c.scope,
      projectRoot: c.projectRoot,
      transport: c.config.type,
      state: c.state,
      error: c.error,
      hint:
        c.state === 'connected' && c.tools.length === 0
          ? (troubleshootFor(c.name) ?? 'Connected, but it offers no tools yet. They appear here as soon as it does.')
          : null,
      tools: c.tools.map((t) => ({ ...t }))
    }));
  }

  /** Tool names visible to sessions in `projectRoot` (user servers plus that project's own). */
  toolNames(projectRoot: string | null = null): string[] {
    return [...this.connections.values()]
      .filter((c) => c.state === 'connected' && (c.projectRoot === null || c.projectRoot === projectRoot))
      .flatMap((c) => c.tools.map((t) => t.registeredAs));
  }

  serverNames(projectRoot: string | null = null): string[] {
    return [...this.connections.values()].filter((c) => c.state === 'connected' && (c.projectRoot === null || c.projectRoot === projectRoot)).map((c) => c.name);
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.connections.values()].map((c) => this.disconnect(c)));
    this.connections.clear();
  }
}

/** Every page of a server's tool list. */
async function listAllTools(client: Client): Promise<RemoteTool[]> {
  const tools: RemoteTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TOOL_PAGES; page++) {
    const listed = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...listed.tools);
    cursor = listed.nextCursor;
    if (!cursor) break;
  }
  return tools;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new GraftError('mcp_timeout', message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}
