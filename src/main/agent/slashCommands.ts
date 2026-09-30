import fs from 'node:fs';
import path from 'node:path';
import { firstParagraph, parseFrontmatter } from './frontmatter';

export interface SlashCommandInfo {
  name: string;
  description: string;
  argumentHint: string | null;
  source: 'builtin' | 'user' | 'project';
  path: string | null;
}

export interface CustomCommand extends SlashCommandInfo {
  body: string;
}

/**
 * Built-in commands. Some act inside the session (clear, compact, cost,
 * help, init, review, model, effort, permissions); others open UI in the
 * renderer (mcp, resume, rewind, config).
 */
export const BUILTIN_COMMANDS: SlashCommandInfo[] = [
  { name: 'clear', description: 'Start over with an empty context (the transcript stays visible)', argumentHint: null },
  { name: 'compact', description: 'Summarize the conversation to free up context', argumentHint: '[what to keep]' },
  { name: 'model', description: 'Switch the model for this session', argumentHint: '[model]' },
  { name: 'effort', description: 'Set the effort level', argumentHint: '[low|medium|high|extra|max|taproot]' },
  { name: 'permissions', description: 'Change the permission mode or edit rules', argumentHint: '[ask|auto-edit|plan|auto]' },
  { name: 'mcp', description: 'Show MCP servers and their status', argumentHint: null },
  { name: 'init', description: 'Analyze the project and write a GRAFT.md for future sessions', argumentHint: null },
  { name: 'review', description: 'Review the current changes for bugs and risks', argumentHint: '[focus]' },
  { name: 'resume', description: 'Open a previous session', argumentHint: null },
  { name: 'cost', description: 'Show token usage for this session', argumentHint: null },
  { name: 'rewind', description: 'Restore files and/or conversation to an earlier message', argumentHint: null },
  { name: 'help', description: 'List commands and shortcuts', argumentHint: null },
  { name: 'config', description: 'Open settings', argumentHint: null }
].map((c) => ({ ...c, source: 'builtin' as const, path: null }));

export const BUILTIN_NAMES = new Set(BUILTIN_COMMANDS.map((c) => c.name));

export function parseSlash(text: string): { name: string; args: string } | null {
  const match = /^\/([A-Za-z0-9_:-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  return { name: match[1]!.toLowerCase(), args: (match[2] ?? '').trim() };
}

function scanCommands(dir: string, source: 'user' | 'project', prefix = ''): CustomCommand[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const out: CustomCommand[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...scanCommands(full, source, `${prefix}${entry.name}:`));
      continue;
    }
    if (!entry.name.toLowerCase().endsWith('.md')) continue;
    const { data, body } = parseFrontmatter(fs.readFileSync(full, 'utf8'));
    const name = `${prefix}${entry.name.slice(0, -3)}`.toLowerCase();
    if (!/^[a-z0-9_:-]+$/.test(name)) continue;
    out.push({
      name,
      description: data.description ?? (firstParagraph(body) || 'Custom command'),
      argumentHint: data['argument-hint'] ?? null,
      source,
      path: full,
      body
    });
  }
  return out;
}

/** Custom commands from ~/.graft/commands and <project>/.graft/commands; project wins on clashes, built-ins can't be overridden. */
export function loadCustomCommands(graftHome: string, projectRoot: string | null): CustomCommand[] {
  const byName = new Map<string, CustomCommand>();
  for (const c of scanCommands(path.join(graftHome, 'commands'), 'user')) byName.set(c.name, c);
  if (projectRoot) for (const c of scanCommands(path.join(projectRoot, '.graft', 'commands'), 'project')) byName.set(c.name, c);
  for (const name of BUILTIN_NAMES) byName.delete(name);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Substitutes $ARGUMENTS and positional $1…$9. Arguments are appended when the template doesn't reference them. */
export function expandCommand(command: CustomCommand, args: string): string {
  const positional = args.length > 0 ? args.split(/\s+/) : [];
  let usedArgs = false;
  let text = command.body.replace(/\$ARGUMENTS\b/g, () => {
    usedArgs = true;
    return args;
  });
  text = text.replace(/\$([1-9])\b/g, (_m: string, n: string) => {
    usedArgs = true;
    return positional[Number(n) - 1] ?? '';
  });
  if (!usedArgs && args.length > 0) text = `${text.trimEnd()}\n\n${args}`;
  return text.trim();
}

export const INIT_PROMPT = [
  'Analyze this project and write a GRAFT.md file at the project root for future coding sessions.',
  'Cover: what the project is; how to install, build, run, test and lint it (exact commands); the architecture and where the important code lives; conventions that aren\'t obvious from the code (naming, error handling, testing patterns); and gotchas.',
  'Keep it concise and specific — commands and paths, not generic advice. If a GRAFT.md, AGENTS.md or similar already exists, improve it instead of starting over, and keep anything still accurate.'
].join(' ');

export function reviewPrompt(focus: string): string {
  return [
    'Review the current uncommitted changes in this repository (use git status and git diff, including staged changes).',
    'Look for bugs, missed edge cases, security problems, race conditions, broken error handling and missing tests.',
    'Report findings ordered by severity with path:line references and a concrete fix for each. Say plainly if you find nothing significant.',
    focus.length > 0 ? `Focus especially on: ${focus}` : ''
  ]
    .join(' ')
    .trim();
}
