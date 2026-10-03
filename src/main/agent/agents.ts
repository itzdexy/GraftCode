import fs from 'node:fs';
import path from 'node:path';
import { firstParagraph, parseFrontmatter } from './frontmatter';

/**
 * Custom sub-agents: Markdown files in ~/.graft/agents and
 * <project>/.graft/agents. The front matter names the agent, says when to
 * use it and may limit its tools; the body is its instructions. The main
 * agent delegates to one with Task, and a sub-agent never gets a tool the
 * session doesn't have, so a file can only narrow what is allowed.
 *
 *   ---
 *   description: Reviews a diff for bugs and risky changes
 *   tools: Read, Grep, Glob, Shell
 *   ---
 *   You are a meticulous reviewer…
 */

export interface AgentDefinition {
  name: string;
  description: string;
  /** Tool names the agent may use; null gives it the general sub-agent's tools. */
  tools: string[] | null;
  instructions: string;
  source: 'user' | 'project';
  path: string;
}

/** Sub-agent types every session has. */
export const BUILTIN_AGENTS = ['general', 'explore'] as const;

export const AGENT_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TOOL_NAME = /^[A-Za-z][\w-]{0,127}$/;
const MAX_FILE_BYTES = 200_000;

/** Tool names as picked in Customize: each entry must be a whole tool name; null when none is left. */
export function cleanToolNames(names: string[] | null): string[] | null {
  const valid = (names ?? []).map((n) => n.trim()).filter((n) => TOOL_NAME.test(n));
  return valid.length > 0 ? [...new Set(valid)] : null;
}

/** "Read, Grep  Glob" → ["Read", "Grep", "Glob"]; null when the list is absent or empty. */
export function parseToolList(value: string | undefined): string[] | null {
  if (value === undefined) return null;
  const names = value
    .replace(/[[\]"']/g, ' ')
    .split(/[\s,]+/)
    .filter((t) => TOOL_NAME.test(t));
  return names.length > 0 ? [...new Set(names)] : null;
}

function scan(dir: string, source: 'user' | 'project'): AgentDefinition[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return [];
    throw error;
  }
  const out: AgentDefinition[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
    const file = path.join(dir, entry.name);
    if (fs.statSync(file).size > MAX_FILE_BYTES) continue;
    const { data, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    const name = (data.name ?? entry.name.slice(0, -3)).toLowerCase();
    if (!AGENT_NAME.test(name) || (BUILTIN_AGENTS as readonly string[]).includes(name)) continue;
    const instructions = body.trim();
    if (instructions.length === 0) continue;
    out.push({
      name,
      description: (data.description ?? firstParagraph(body)) || 'Custom agent',
      tools: parseToolList(data.tools),
      instructions,
      source,
      path: file
    });
  }
  return out;
}

/** The user's agents and the project's; a project agent replaces a user agent with the same name. */
export function loadAgents(graftHome: string, projectRoot: string | null): AgentDefinition[] {
  const byName = new Map<string, AgentDefinition>();
  for (const a of scan(path.join(graftHome, 'agents'), 'user')) byName.set(a.name, a);
  if (projectRoot) for (const a of scan(path.join(projectRoot, '.graft', 'agents'), 'project')) byName.set(a.name, a);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The tools a sub-agent runs with: explore gets the read-only tools, a custom
 * agent the tools it lists, and anything else the session's tools, always
 * limited to what the session has and never the main agent's own tools.
 */
export function subagentTools(available: string[], readOnly: readonly string[], parentOnly: readonly string[], type: string, agent: AgentDefinition | null): string[] {
  const usable = available.filter((n) => !parentOnly.includes(n));
  if (type === 'explore') return readOnly.filter((n) => usable.includes(n));
  if (agent?.tools) return usable.filter((n) => agent.tools?.includes(n));
  return usable;
}
