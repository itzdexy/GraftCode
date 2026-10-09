import fs from 'node:fs';
import path from 'node:path';
import { askUserTool, exitPlanModeTool, missionUpdateTool, runAgentsTool, taskTool, todoWriteTool } from './agentTools';
import { editTool, multiEditTool } from './fs/edit';
import { readTool } from './fs/read';
import { writeTool } from './fs/write';
import { ToolRegistry } from './registry';
import { globTool } from './search/glob';
import { grepTool } from './search/grep';
import { symbolsTool } from './search/symbols';
import { killShellTool, shellOutputTool, shellTool } from './shell/shellTools';
import { webFetchTool } from './web/webFetch';
import { webSearchTool } from './web/webSearch';
import { computerTool } from './computer';
import { browserTool } from './browserTool';
import { createFileTool, runCodeTool } from './chat/chatTools';
import { comfyTool, generateImageTool } from './media';
import { toolSearchTool } from './toolSearch';
import { semanticCodeTool } from './search/semantic';
import type { LanguageServers } from '../languages/servers';

/** Tool names by role; sub-agents and plan mode filter with these. */
export const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'Symbols', 'SemanticCode', 'WebFetch', 'WebSearch'] as const;
/** Tools a sub-agent may never use (no nesting, no user interaction). */
export const PARENT_ONLY_TOOLS = ['Task', 'RunAgents', 'AskUserQuestion', 'ExitPlanMode', 'TodoWrite', 'MissionUpdate', 'Browser', 'ToolSearch'] as const;
/** Tools offered in chats only; code sessions have Write and Shell instead. */
export const CHAT_ONLY_TOOLS = ['CreateFile', 'RunCode'] as const;

export function createBuiltinRegistry(languages: LanguageServers | null = null): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(readTool);
  registry.register(writeTool);
  registry.register(editTool);
  registry.register(multiEditTool);
  registry.register(globTool);
  registry.register(grepTool);
  registry.register(symbolsTool);
  registry.register(semanticCodeTool(languages));
  registry.register(shellTool);
  registry.register(shellOutputTool);
  registry.register(killShellTool);
  registry.register(webFetchTool);
  registry.register(webSearchTool);
  registry.register(computerTool);
  registry.register(browserTool);
  registry.register(todoWriteTool);
  registry.register(taskTool);
  registry.register(runAgentsTool);
  registry.register(missionUpdateTool);
  registry.register(askUserTool);
  registry.register(exitPlanModeTool);
  registry.register(createFileTool);
  registry.register(runCodeTool);
  registry.register(generateImageTool);
  registry.register(comfyTool);
  registry.register(toolSearchTool);
  return registry;
}

/**
 * Locates the ripgrep binary shipped by @vscode/ripgrep's platform package via
 * Node module resolution, so it works from the dev tree, the built bundle and
 * a packaged app (where the binary lives in app.asar.unpacked).
 */
export function findRipgrep(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  resolve: (id: string) => string = require.resolve
): string {
  const binary = platform === 'win32' ? 'rg.exe' : 'rg';
  const id = `@vscode/ripgrep-${platform}-${arch}/bin/${binary}`;
  let resolved: string;
  try {
    resolved = resolve(id);
  } catch (error) {
    throw new Error(`ripgrep for ${platform}-${arch} is not installed (${id}): ${(error as Error).message}`, { cause: error });
  }
  const unpacked = resolved.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  if (fs.existsSync(unpacked)) return unpacked;
  if (fs.existsSync(resolved)) return resolved;
  throw new Error(`ripgrep binary not found at ${unpacked}`);
}
