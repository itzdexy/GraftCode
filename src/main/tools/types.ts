import type { z } from 'zod';
import type { ToolResultContent } from '@shared/schemas/messages';
import type { PermissionDetail, Question, QuestionAnswer } from '@shared/schemas/permissions';
import type { TodoItem, ToolDisplay } from '@shared/schemas/toolDisplay';
import type { FileStateTracker } from './fileState';
import type { ShellManager } from './shell/shellManager';

export type PermissionClass = 'read' | 'write' | 'exec' | 'network' | 'none';
export type SubagentType = 'general' | 'explore';

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
}

export interface DescribeContext {
  cwd: string;
  projectRoot: string;
  platform: NodeJS.Platform;
}

export interface ToolContext extends DescribeContext {
  sessionId: string;
  toolUseId: string;
  signal: AbortSignal;
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
  approvePlan(plan: string): Promise<{ approved: boolean; feedback: string | null }>;
  runSubagent(input: { description: string; prompt: string; type: SubagentType }): Promise<{ text: string; toolCalls: number }>;
  /** Project notes (GRAFT.md) for directories first touched by these paths, or null. */
  notesForPaths(paths: string[]): string | null;
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
