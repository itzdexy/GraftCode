import path from 'node:path';
import type { TodoItem } from '../../src/shared/schemas/toolDisplay';
import { FileStateTracker } from '../../src/main/tools/fileState';
import { findRipgrep } from '../../src/main/tools/builtin';
import { detectShell } from '../../src/main/tools/shell/detect';
import { ShellManager } from '../../src/main/tools/shell/shellManager';
import type { ToolContext } from '../../src/main/tools/types';

export const RG_PATH = findRipgrep();

export function makeShellManager(logDir: string): ShellManager {
  return new ShellManager(detectShell(process.platform, process.env), logDir);
}

export function makeToolContext(dir: string, overrides: Partial<ToolContext> = {}): ToolContext & { todoList: TodoItem[]; progressChunks: string[] } {
  const todoList: TodoItem[] = [];
  const progressChunks: string[] = [];
  const ctx: ToolContext & { todoList: TodoItem[]; progressChunks: string[] } = {
    sessionId: 'session-test',
    toolUseId: 'tool-1',
    cwd: dir,
    projectRoot: dir,
    platform: process.platform,
    signal: new AbortController().signal,
    files: new FileStateTracker(),
    shells: makeShellManager(path.join(dir, '.logs')),
    rgPath: RG_PATH,
    modelSupportsVision: true,
    todos: {
      get: () => todoList,
      set: (items) => {
        todoList.splice(0, todoList.length, ...items);
      }
    },
    progress: (chunk) => progressChunks.push(chunk),
    askUser: () => Promise.resolve(null),
    approvePlan: () => Promise.resolve({ approved: false, feedback: null }),
    runSubagent: () => Promise.resolve({ text: '', toolCalls: 0 }),
    notesForPaths: () => null,
    search: () => Promise.reject(new Error('No web search engine in this test.')),
    computer: null,
    chatFiles: null,
    runCode: null,
    browser: null,
    todoList,
    progressChunks,
    ...overrides
  };
  return ctx;
}
