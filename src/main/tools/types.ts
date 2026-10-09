import type { z } from 'zod';
import type { Source } from '@shared/sources';
import type { ToolResultContent } from '@shared/schemas/messages';
import type { PermissionDetail, Question, QuestionAnswer } from '@shared/schemas/permissions';
import type { TodoItem, ToolDisplay } from '@shared/schemas/toolDisplay';
import type { FileStateTracker } from './fileState';
import type { ShellManager } from './shell/shellManager';
import type { SearchEngineId, SearchResult } from './web/search';
import type { ComputerControl } from '../computer/desktop';
import type { ChatFile } from '../chat/chatFiles';
import type { CodeRun } from '../chat/codeSandbox';
import type { DocumentKind } from '../chat/documents';
import type { ConsoleEntry, PageSnapshot } from '../browser/browserPanel';
import type { MediaAccess } from '../media/mediaService';
import type { AgentGroupInput } from '../agent/agentGroup';
import type { MissionUpdateInput } from '../agent/mission';

export type PermissionClass = 'read' | 'write' | 'exec' | 'network' | 'computer' | 'none';
/** "general", "explore", or the name of a custom agent (see agent/agents.ts). */
export type SubagentType = string;

/** What a pending call touches; drives permission checks, prompts and summary lines. */
export interface ToolCallDescriptor {
  /** One-line human summary, e.g. "Read src/app.ts" or "Ran npm test". */
  summary: string;
  reads?: string[];
  writes?: string[];
  command?: string;
  url?: string;
  /** What a permission prompt shows (command, diff, URL…). */
  preview?: PermissionDetail;
  /** Works on the page already open in the Browser panel: "look" only reads it, "act" clicks or types. */
  page?: 'look' | 'act';
}

export interface DescribeContext {
  cwd: string;
  projectRoot: string;
  platform: NodeJS.Platform;
}

export interface ToolContext extends DescribeContext {
  /** Only trusted code projects may start a bundled local language server. */
  trustedProject?: boolean;
  sessionId: string;
  toolUseId: string;
  signal: AbortSignal;
  /** The project whose MCP servers this session may use (its settings folder); null for chats, which use the user's own. */
  mcpRoot: string | null;
  files: FileStateTracker;
  shells: ShellManager;
  /** Path to the ripgrep binary. */
  rgPath: string;
  modelSupportsVision: boolean;
  todos: { get(): TodoItem[]; set(items: TodoItem[]): void };
  /** Streams incremental output (e.g. shell) to the UI. */
  progress(chunk: string): void;
  /** Resolves null when the user dismisses the card. */
  askUser(questions: Question[]): Promise<QuestionAnswer[] | null>;
  /** Asks the user to approve a plan. `plan` in the answer is the version to follow: theirs when they edited it, else the one offered. */
  approvePlan(plan: string): Promise<{ approved: boolean; feedback: string | null; plan: string }>;
  runSubagent(input: { description: string; prompt: string; type: SubagentType }): Promise<{ text: string; toolCalls: number }>;
  /** Runs a group of agents (RunAgents) and returns their combined report with how each one ended. */
  runAgents(input: AgentGroupInput): Promise<{ report: string; agents: Array<{ nodeId: string; title: string; role: string; status: string; durationMs: number | null }>; sources: Source[] }>;
  /** Project notes (GRAFT.md) for directories first touched by these paths, or null. */
  notesForPaths(paths: string[]): string | null;
  /** Screen, mouse and keyboard when computer use is on (Settings → Permissions); null otherwise. */
  computer: ComputerControl | null;
  /** Searches the web with the engine chosen in Settings → Web search. */
  search(query: string, count: number, signal: AbortSignal): Promise<{ engine: SearchEngineId; results: SearchResult[] }>;
  /** Pages are read without asking here (a chat), so reading must stay on the public web: see WebFetch. */
  publicWebOnly: boolean;
  /** Saves files the user can download from the chat; null outside chats and in incognito chats. */
  chatFiles: { save(name: string, data: Buffer): ChatFile } | null;
  /** Builds a PDF, a text document, slides or a spreadsheet from what was written, for CreateFile; null where files can't be made. */
  makeDocument: ((kind: DocumentKind, name: string, source: string, signal: AbortSignal) => Promise<Buffer>) | null;
  /** Runs JavaScript in an isolated page with no network or file access; null outside chats. */
  runCode: ((code: string, timeoutMs: number, signal: AbortSignal) => Promise<CodeRun>) | null;
  /** The Browser panel, for the Browser tool; null outside code sessions or without a window. */
  browser: AgentBrowser | null;
  /** Image models and ComfyUI (Settings → Images); null where generated media isn't available. */
  media: MediaAccess | null;
  /** The session's mission while one is open (MissionUpdate); null otherwise, and always for sub-agents. */
  mission: { update(input: MissionUpdateInput): { reply: string; isError: boolean } } | null;
  /** Adds money a tool spent on the user's key (a generated image) to the session's cost. */
  spend(costUsd: number): void;
  /** MCP tools that wait to be loaded; null when the session offers all of them. */
  deferredTools: DeferredTools | null;
}

/** An MCP tool whose definition is not sent with every request: found by searching, then loaded. */
export interface DeferredTool {
  name: string;
  server: string;
  description: string;
}

/** The tools of a big MCP setup that wait to be loaded (ToolSearch); null when every tool is offered. */
export interface DeferredTools {
  find(query: string, limit: number): DeferredTool[];
  /** Offers these tools from the next request on, for the rest of the session. */
  load(names: string[]): void;
  /** What is waiting, for when a search finds nothing. */
  summary(): string;
}

/** The Browser panel as the agent drives it. Pages are isolated from the user's files and accounts. */
export interface AgentBrowser {
  /** Opens a page (showing the panel) and waits for it to load; returns the address it opened. */
  open(url: string): Promise<string>;
  snapshot(): Promise<PageSnapshot>;
  capture(): Promise<{ mediaType: 'image/png' | 'image/jpeg'; data: string; width: number; height: number }>;
  click(target: PageTarget): Promise<string>;
  type(target: PageTarget, text: string, submit: boolean): Promise<string>;
  press(key: string): Promise<void>;
  scroll(direction: 'up' | 'down'): Promise<void>;
  back(): Promise<void>;
  reload(): Promise<void>;
  waitForText(text: string, timeoutMs: number): Promise<boolean>;
  console(): ConsoleEntry[];
  currentUrl(): string | null;
}

export interface PageTarget {
  ref?: number;
  selector?: string;
  text?: string;
}

export interface ToolResult {
  isError: boolean;
  /** What the model sees. */
  content: ToolResultContent[];
  /** What the UI shows. */
  display: ToolDisplay;
}

export interface ToolDefinition<I = unknown> {
  name: string;
  description: string;
  input: z.ZodType<I>;
  /** Raw JSON Schema offered to models instead of one derived from `input` (MCP tools bring their own). */
  jsonSchema?: Record<string, unknown>;
  permissionClass: PermissionClass;
  /** Present for MCP tools: the server name and the server's own safety annotations. */
  mcp?: { server: string; tool: string; readOnly: boolean; destructive: boolean };
  /** True when the call may run in parallel with other safe calls from the same response. */
  concurrencySafe(input: I): boolean;
  /** Hard ceiling for one call; the shell tool also honors a per-call timeout. */
  timeoutMs: number;
  describe(input: I, ctx: DescribeContext): Promise<ToolCallDescriptor>;
  execute(input: I, ctx: ToolContext): Promise<ToolResult>;
}

/** Erases the input type for storage in the registry. */
export type AnyTool = ToolDefinition<never>;

export function textResult(text: string, display: ToolDisplay, isError = false): ToolResult {
  return { isError, content: [{ type: 'text', text }], display };
}

export function errorResult(message: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: message }], display: { kind: 'error', message } };
}
