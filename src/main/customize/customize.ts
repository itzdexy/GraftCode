import fs from 'node:fs';
import path from 'node:path';
import { GraftError } from '@shared/errors';
import { BUILTIN_AGENTS, cleanToolNames, loadAgents } from '../agent/agents';
import { BUILTIN_NAMES, loadCustomCommands, PROMPT_COMMANDS } from '../agent/slashCommands';
import { loadSkills } from '../agent/skills';
import { MEMORY_FILE_NAMES } from '../agent/memory';
import { writeFileAtomic } from '../tools/fs/write';
import { isInside } from '../tools/paths';

/**
 * File-backed customizations edited from the Customize screen: slash
 * commands, agents, skills and GRAFT.md memory files, for the user
 * (~/.graft) or a project (<project>/.graft and <project>/GRAFT.md).
 */

export type CustomScope = 'user' | 'project';

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_FILE_CHARS = 200_000;

export interface CommandFile {
  name: string;
  description: string;
  argumentHint: string | null;
  scope: CustomScope;
  path: string;
  body: string;
}

export interface SkillFile {
  name: string;
  description: string;
  scope: CustomScope;
  path: string;
  body: string;
}

export interface MemoryInfo {
  scope: CustomScope;
  path: string;
  exists: boolean;
  content: string;
  /** Another instruction file Graft reads when GRAFT.md is absent (AGENTS.md / CLAUDE.md). */
  fallback: string | null;
}

function baseDir(graftHome: string, scope: CustomScope, projectRoot: string | null): string {
  if (scope === 'user') return graftHome;
  if (!projectRoot) throw new GraftError('project_required', 'Choose a project for project customizations.');
  return path.join(projectRoot, '.graft');
}

function quote(value: string): string {
  return /^[\w .,/()-]*$/.test(value) ? value : JSON.stringify(value);
}

function frontmatter(fields: Record<string, string | null>): string {
  const lines = Object.entries(fields)
    .filter((e): e is [string, string] => e[1] !== null && e[1].trim().length > 0)
    .map(([k, v]) => `${k}: ${quote(v.replace(/\r?\n/g, ' ').trim())}`);
  return lines.length > 0 ? `---\n${lines.join('\n')}\n---\n\n` : '';
}

function checkName(name: string, what: string): void {
  if (!NAME.test(name)) throw new GraftError('invalid_name', `${what} names use lowercase letters, digits, "-" and "_" (up to 64).`);
}

function checkSize(text: string): void {
  if (text.length > MAX_FILE_CHARS) throw new GraftError('too_large', 'That file is too large (200,000 characters at most).');
}

/** The file must live in one of the allowed directories (never anywhere else on disk). */
function assertWithin(file: string, dirs: string[]): void {
  if (!dirs.some((d) => isInside(d, file))) throw new GraftError('outside_folder', 'That file is not a Graft customization.');
}

export function listCommands(graftHome: string, projectRoot: string | null): CommandFile[] {
  const out: CommandFile[] = [];
  for (const c of loadCustomCommands(graftHome, projectRoot)) {
    if (c.source === 'builtin' || !c.path) continue;
    out.push({ name: c.name, description: c.description, argumentHint: c.argumentHint, scope: c.source, path: c.path, body: c.body });
  }
  return out;
}

export async function saveCommand(
  graftHome: string,
  input: { scope: CustomScope; projectRoot: string | null; name: string; description: string; argumentHint: string | null; body: string; previousPath: string | null }
): Promise<string> {
  checkName(input.name, 'Command');
  // The prompt built-ins (/review, /commit…) can be replaced; the ones that control sessions and the app can't.
  if (BUILTIN_NAMES.has(input.name) && !PROMPT_COMMANDS.has(input.name)) throw new GraftError('reserved_name', `/${input.name} is a built-in command. Pick another name.`);
  checkSize(input.body);
  const dir = path.join(baseDir(graftHome, input.scope, input.projectRoot), 'commands');
  const file = path.join(dir, `${input.name}.md`);
  await writeFileAtomic(file, `${frontmatter({ description: input.description, 'argument-hint': input.argumentHint })}${input.body.trim()}\n`);
  if (input.previousPath && path.resolve(input.previousPath) !== path.resolve(file)) await deleteCommand(graftHome, input.projectRoot, input.previousPath);
  return file;
}

export async function deleteCommand(graftHome: string, projectRoot: string | null, file: string): Promise<void> {
  const dirs = [path.join(graftHome, 'commands'), ...(projectRoot ? [path.join(projectRoot, '.graft', 'commands')] : [])];
  assertWithin(file, dirs);
  if (!file.toLowerCase().endsWith('.md')) throw new GraftError('outside_folder', 'That file is not a command.');
  await fs.promises.rm(file, { force: true });
}

export interface AgentFile {
  name: string;
  description: string;
  tools: string[] | null;
  scope: CustomScope;
  path: string;
  body: string;
}

export function listAgents(graftHome: string, projectRoot: string | null): AgentFile[] {
  return loadAgents(graftHome, projectRoot).map((a) => ({ name: a.name, description: a.description, tools: a.tools, scope: a.source, path: a.path, body: a.instructions }));
}

export async function saveAgent(
  graftHome: string,
  input: { scope: CustomScope; projectRoot: string | null; name: string; description: string; tools: string[] | null; body: string; previousPath: string | null }
): Promise<string> {
  checkName(input.name, 'Agent');
  if ((BUILTIN_AGENTS as readonly string[]).includes(input.name)) throw new GraftError('reserved_name', `"${input.name}" is a built-in agent. Pick another name.`);
  if (input.body.trim().length === 0) throw new GraftError('empty_agent', 'Write the agent’s instructions first.');
  checkSize(input.body);
  const tools = cleanToolNames(input.tools);
  const dir = path.join(baseDir(graftHome, input.scope, input.projectRoot), 'agents');
  const file = path.join(dir, `${input.name}.md`);
  await writeFileAtomic(file, `${frontmatter({ description: input.description, tools: tools ? tools.join(', ') : null })}${input.body.trim()}\n`);
  if (input.previousPath && path.resolve(input.previousPath) !== path.resolve(file)) await deleteAgent(graftHome, input.projectRoot, input.previousPath);
  return file;
}

export async function deleteAgent(graftHome: string, projectRoot: string | null, file: string): Promise<void> {
  const dirs = [path.join(graftHome, 'agents'), ...(projectRoot ? [path.join(projectRoot, '.graft', 'agents')] : [])];
  assertWithin(file, dirs);
  if (!file.toLowerCase().endsWith('.md')) throw new GraftError('outside_folder', 'That file is not an agent.');
  await fs.promises.rm(file, { force: true });
}

export function listSkills(graftHome: string, projectRoot: string | null): SkillFile[] {
  return loadSkills(graftHome, projectRoot).map((s) => {
    const raw = fs.readFileSync(s.path, 'utf8');
    const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trimStart();
    return { name: s.name, description: s.description, scope: s.scope, path: s.path, body };
  });
}

export async function saveSkill(
  graftHome: string,
  input: { scope: CustomScope; projectRoot: string | null; name: string; description: string; body: string; previousPath: string | null }
): Promise<string> {
  checkName(input.name, 'Skill');
  checkSize(input.body);
  if (input.description.trim().length === 0) throw new GraftError('description_required', 'Describe when the skill should be used; the agent decides from this.');
  const file = path.join(baseDir(graftHome, input.scope, input.projectRoot), 'skills', input.name, 'SKILL.md');
  await writeFileAtomic(file, `${frontmatter({ name: input.name, description: input.description })}${input.body.trim()}\n`);
  if (input.previousPath && path.resolve(input.previousPath) !== path.resolve(file)) await deleteSkill(graftHome, input.projectRoot, input.previousPath);
  return file;
}

/** Deletes a skill folder (only the <skills>/<name> folder that holds the SKILL.md). */
export async function deleteSkill(graftHome: string, projectRoot: string | null, skillFile: string): Promise<void> {
  const roots = [path.join(graftHome, 'skills'), ...(projectRoot ? [path.join(projectRoot, '.graft', 'skills')] : [])];
  const folder = path.dirname(skillFile);
  if (path.basename(skillFile) !== 'SKILL.md' || !roots.some((r) => path.resolve(path.dirname(folder)) === path.resolve(r))) {
    throw new GraftError('outside_folder', 'That folder is not a skill.');
  }
  await fs.promises.rm(folder, { recursive: true, force: true });
}

function memoryFor(dir: string, scope: CustomScope, file: string): MemoryInfo {
  const exists = fs.existsSync(file);
  const fallback = exists ? null : (MEMORY_FILE_NAMES.slice(1).map((n) => path.join(dir, n)).find((f) => fs.existsSync(f)) ?? null);
  return { scope, path: file, exists, content: exists ? fs.readFileSync(file, 'utf8') : '', fallback };
}

export function listMemory(graftHome: string, projectRoot: string | null): MemoryInfo[] {
  const out = [memoryFor(graftHome, 'user', path.join(graftHome, 'GRAFT.md'))];
  if (projectRoot) out.push(memoryFor(projectRoot, 'project', path.join(projectRoot, 'GRAFT.md')));
  return out;
}

export async function saveMemory(graftHome: string, scope: CustomScope, projectRoot: string | null, content: string): Promise<string> {
  checkSize(content);
  if (scope === 'project' && !projectRoot) throw new GraftError('project_required', 'Choose a project first.');
  const file = scope === 'user' ? path.join(graftHome, 'GRAFT.md') : path.join(projectRoot ?? '', 'GRAFT.md');
  await writeFileAtomic(file, content.endsWith('\n') ? content : `${content}\n`);
  return file;
}
