import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { z } from 'zod';
import type { McpServerConfig, SettingsScope } from '@shared/schemas/config';
import type { ImageBlock, ToolResultContent } from '@shared/schemas/messages';
import { GraftError } from '@shared/errors';
import type { McpToolSource } from '../agent/sessionManager';
import type { SettingsStore } from '../permissions/settingsStore';
import type { KeyStore } from '../secrets/keyStore';
import type { ToolRegistry } from '../tools/registry';
import type { ToolDefinition } from '../tools/types';
import { serverKey } from './mcpConfig';
import { McpOAuthProvider, startOAuthCallback } from './oauth';

const CONNECT_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 120_000;
const MAX_RESULT_CHARS = 100_000;

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

interface Connection {
  name: string;
  scope: SettingsScope;
  projectRoot: string | null;
  config: McpServerConfig;
  key: string;
  state: McpState;
  error: string | null;
  client: Client | null;
  transport: StdioClientTransport | StreamableHTTPClientTransport | null;
  tools: McpToolInfo[];
  /** Last lines a stdio server wrote to stderr (shown when it fails to start). */
  stderr: string;
}

export interface McpManagerDeps {
  settings: SettingsStore;
  registry: ToolRegistry;
  keys: KeyStore;
  openBrowser: (url: string) => Promise<void>;
  log: (level: 'info' | 'warn', message: string, fields?: Record<string, string>) => void;
  onChange: () => void;
}

/**
 * Connects the MCP servers from settings files and registers their tools as
 * mcp__server__tool. User-scope servers connect at startup; project and local
 * servers connect when a session in that (trusted) project starts.
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
      const conn: Connection = { ...w, key: configKey(w.config), state: 'connecting', error: null, client: null, transport: null, tools: [], stderr: '' };
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

  private transportFor(conn: Connection, authProvider: McpOAuthProvider | null): StdioClientTransport | StreamableHTTPClientTransport {
    const c = conn.config;
    if (c.type === 'stdio') {
      return new StdioClientTransport({
        command: c.command,
        args: c.args,
        env: { ...getDefaultEnvironment(), ...c.env },
        ...(c.cwd ? { cwd: c.cwd } : conn.projectRoot ? { cwd: conn.projectRoot } : {}),
        stderr: 'pipe'
      });
    }
    return new StreamableHTTPClientTransport(new URL(c.url), {
      requestInit: { headers: c.headers },
      ...(authProvider ? { authProvider } : {})
    });
  }

  private async connect(conn: Connection, authProvider: McpOAuthProvider | null = null): Promise<void> {
    conn.state = 'connecting';
    conn.error = null;
    this.deps.onChange();
    const transport = this.transportFor(conn, authProvider ?? this.storedAuth(conn));
    conn.stderr = '';
    if (transport instanceof StdioClientTransport) {
      transport.stderr?.on('data', (chunk: Buffer) => {
        conn.stderr = (conn.stderr + chunk.toString('utf8')).slice(-2000);
      });
    }
    const client = new Client({ name: 'graft', version: '0.1.0' }, { capabilities: {} });
    try {
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `${conn.name} did not answer within 30 seconds.`);
      const listed = await client.listTools();
      conn.client = client;
      conn.transport = transport;
      this.registerTools(conn, listed.tools);
      conn.state = 'connected';
      client.onclose = () => {
        if (conn.client !== client) return;
        this.unregisterTools(conn);
        conn.client = null;
        conn.state = 'failed';
        conn.error = 'The server closed the connection.';
        this.deps.onChange();
      };
      this.deps.log('info', 'MCP server connected', { server: conn.name, tools: String(conn.tools.length) });
    } catch (error) {
      await transport.close().catch((closeError: unknown) => this.deps.log('warn', 'MCP transport close failed', { server: conn.name, message: (closeError as Error).message }));
      if (error instanceof UnauthorizedError) {
        conn.state = 'needs-auth';
        conn.error = 'This server needs you to sign in.';
      } else {
        conn.state = 'failed';
        const tail = conn.stderr.trim().split(/\r?\n/).slice(-3).join(' ');
        conn.error = tail ? `${(error as Error).message} — ${tail}` : (error as Error).message;
      }
      this.deps.log('warn', 'MCP server failed to connect', { server: conn.name, message: conn.error });
    }
    this.deps.onChange();
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
        timeoutMs: CALL_TIMEOUT_MS,
        describe: (input) =>
          Promise.resolve({
            summary: `${conn.name} · ${tool.name}`,
            preview: { kind: 'mcp', server: conn.name, tool: tool.name, input: JSON.stringify(input, null, 2).slice(0, 4000) }
          }),
        execute: async (input, ctx) => {
          const client = conn.client;
          if (!client) throw new GraftError('mcp_disconnected', `The ${conn.name} MCP server is not connected.`);
          const result = await client.callTool({ name: tool.name, arguments: input }, undefined, { signal: ctx.signal, timeout: CALL_TIMEOUT_MS });
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
      const client = new Client({ name: 'graft', version: '0.1.0' }, { capabilities: {} });
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
