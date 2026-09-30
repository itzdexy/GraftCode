import fs from 'node:fs';
import path from 'node:path';
import { askUserTool, exitPlanModeTool, taskTool, todoWriteTool } from './agentTools';
import { editTool, multiEditTool } from './fs/edit';
import { readTool } from './fs/read';
import { writeTool } from './fs/write';
import { ToolRegistry } from './registry';
import { globTool } from './search/glob';
import { grepTool } from './search/grep';
import { killShellTool, shellOutputTool, shellTool } from './shell/shellTools';
import { webFetchTool } from './web/webFetch';

/** Tool names by role; sub-agents and plan mode filter with these. */
export const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'WebFetch'] as const;
/** Tools a sub-agent may never use (no nesting, no user interaction). */
export const PARENT_ONLY_TOOLS = ['Task', 'AskUserQuestion', 'ExitPlanMode', 'TodoWrite'] as const;

export function createBuiltinRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(readTool);
  registry.register(writeTool);
  registry.register(editTool);
  registry.register(multiEditTool);
  registry.register(globTool);
  registry.register(grepTool);
  registry.register(shellTool);
  registry.register(shellOutputTool);
  registry.register(killShellTool);
  registry.register(webFetchTool);
  registry.register(todoWriteTool);
  registry.register(taskTool);
  registry.register(askUserTool);
  registry.register(exitPlanModeTool);
  return registry;
}

/**
 * Locates the ripgrep binary shipped by @vscode/ripgrep's platform package.
 * In a packaged app the binary lives in app.asar.unpacked.
 */
export function findRipgrep(appRoot: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  const binary = platform === 'win32' ? 'rg.exe' : 'rg';
  const candidate = path.join(appRoot, 'node_modules', '@vscode', `ripgrep-${platform}-${arch}`, 'bin', binary);
  const unpacked = candidate.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  if (fs.existsSync(unpacked)) return unpacked;
  if (fs.existsSync(candidate)) return candidate;
  throw new Error(`ripgrep binary not found at ${unpacked}`);
}
