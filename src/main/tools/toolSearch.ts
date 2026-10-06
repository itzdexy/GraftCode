import { z } from 'zod';
import { errorResult, textResult, type DeferredTool, type ToolDefinition } from './types';

/** An MCP tool that is not loaded: enough to find it by. */
export type SearchableTool = DeferredTool;

/** Most tools one search loads when it asks for a whole server. */
const WHOLE_SERVER = 40;

/** Words that say nothing about which tool is wanted. */
const FILLER = new Set(['the', 'an', 'to', 'for', 'of', 'and', 'or', 'in', 'on', 'with', 'tool', 'tools', 'mcp', 'use', 'that', 'can', 'need']);

function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/**
 * Finds tools that are not loaded: by the words of their names first, then the
 * server they come from and what their descriptions say. `select:name,name`
 * takes tools by their exact names instead.
 */
export function searchTools(tools: SearchableTool[], query: string, limit: number): SearchableTool[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];
  if (/^select:/i.test(trimmed)) {
    const byName = new Map(tools.map((t) => [t.name.toLowerCase(), t]));
    const found: SearchableTool[] = [];
    for (const name of trimmed.slice('select:'.length).split(',')) {
      const tool = byName.get(name.trim().toLowerCase());
      if (tool && !found.includes(tool)) found.push(tool);
    }
    return found.slice(0, limit);
  }
  const terms = wordsOf(trimmed).filter((w) => w.length > 1 && !FILLER.has(w));
  if (terms.length === 0) return [];
  // Just a server's name asks for that server's tools, all of them: a few of many would be of little use.
  const servers = new Set(tools.map((t) => t.server.toLowerCase()));
  if (terms.every((term) => servers.has(term))) {
    return tools
      .filter((t) => terms.includes(t.server.toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, Math.max(limit, WHOLE_SERVER));
  }
  const scored = tools.map((tool) => {
    const own = tool.name.split('__').slice(2).join('_').toLowerCase();
    const ownWords = wordsOf(own);
    const server = tool.server.toLowerCase();
    const description = tool.description.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (ownWords.includes(term)) score += 4;
      if (own.includes(term)) score += 2;
      if (server === term) score += 3;
      else if (server.includes(term)) score += 1;
      if (description.includes(term)) score += 1;
    }
    return { tool, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, limit)
    .map((s) => s.tool);
}

const ToolSearchInput = z.object({
  query: z.string().min(1).max(200).describe('What you need a tool for, in a few words, or select:<tool name>[,<tool name>] to load tools by their exact names.'),
  max_results: z.number().int().min(1).max(20).optional().describe('At most this many tools are loaded (default 8).')
});
type ToolSearchInput = z.infer<typeof ToolSearchInput>;

function firstLine(text: string): string {
  const line = text.split('\n')[0] ?? '';
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

export const toolSearchTool: ToolDefinition<ToolSearchInput> = {
  name: 'ToolSearch',
  description:
    'Finds tools of the connected MCP servers that are not loaded yet, and loads them for the rest of the session. Use it when the task needs a capability none of your tools has: say what you need in a few words, or pass select:<tool name>. The matching tools are listed with their descriptions and can be called by name right after.',
  input: ToolSearchInput,
  permissionClass: 'none',
  concurrencySafe: () => false,
  timeoutMs: 10_000,
  describe: (input) => Promise.resolve({ summary: `Search tools for “${input.query}”` }),
  execute: (input, ctx) => {
    const waiting = ctx.deferredTools;
    if (!waiting) return Promise.resolve(errorResult('No tools are waiting to be loaded: every tool is already available.'));
    const found = waiting.find(input.query, input.max_results ?? 8);
    if (found.length === 0) {
      const text = `No tool that is not loaded matches “${input.query}”. ${waiting.summary()}`;
      return Promise.resolve(textResult(text, { kind: 'text', text }));
    }
    waiting.load(found.map((t) => t.name));
    const text = [`Loaded ${String(found.length)} ${found.length === 1 ? 'tool' : 'tools'}. Call ${found.length === 1 ? 'it' : 'them'} by name:`, ...found.map((t) => `- ${t.name}: ${firstLine(t.description)}`)].join('\n');
    return Promise.resolve(textResult(text, { kind: 'text', text }));
  }
};
