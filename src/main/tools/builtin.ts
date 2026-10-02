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
import { webSearchTool } from './web/webSearch';
import { computerTool } from './computer';

/** Tool names by role; sub-agents and plan mode filter with these. */
export const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'] as const;
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
  registry.register(webSearchTool);
  registry.register(computerTool);
  registry.register(todoWriteTool);
  registry.register(taskTool);
  registry.register(askUserTool);
  registry.register(exitPlanModeTool);
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
