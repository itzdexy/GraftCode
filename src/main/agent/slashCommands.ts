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
 * help, model, effort, permissions), some send a prepared prompt (init,
 * review, security-review, explain, test, decompile, commit, pr), and the rest open UI
 * in the renderer (mcp, resume, rewind, config, export, system, new, mission).
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
  { name: 'security-review', description: 'Check the current changes for security problems', argumentHint: '[focus]' },
  { name: 'explain', description: 'Explain how part of the project works', argumentHint: '[file, folder or feature]' },
  { name: 'test', description: 'Run the tests and fix what fails, or add tests for something', argumentHint: '[what to test]' },
  { name: 'decompile', description: 'Turn compiled code back into source, one function at a time, checked against the original', argumentHint: '[function, file or binary]' },
  { name: 'commit', description: 'Commit the current changes with a well-written message', argumentHint: '[hint]' },
  { name: 'pr', description: 'Push a branch and open a pull request for the changes', argumentHint: '[hint]' },
  { name: 'mission', description: 'Start a mission: Graft keeps working on an objective until its checks pass', argumentHint: '[objective]' },
  { name: 'resume', description: 'Open a previous session', argumentHint: null },
  { name: 'new', description: 'Start a new session', argumentHint: null },
  { name: 'cost', description: 'Show token usage for this session', argumentHint: null },
  { name: 'rewind', description: 'Restore files and/or conversation to an earlier message', argumentHint: null },
  { name: 'export', description: 'Save this session as Markdown', argumentHint: null },
  { name: 'system', description: 'Show the system prompt and tools this session sends', argumentHint: null },
  { name: 'help', description: 'List commands and shortcuts', argumentHint: null },
  { name: 'config', description: 'Open settings', argumentHint: null }
].map((c) => ({ ...c, source: 'builtin' as const, path: null }));

export const BUILTIN_NAMES = new Set(BUILTIN_COMMANDS.map((c) => c.name));

/** Built-ins that only send a prepared prompt: a user or project command with the same name replaces them. */
export const PROMPT_COMMANDS: ReadonlySet<string> = new Set(['init', 'review', 'security-review', 'explain', 'test', 'decompile', 'commit', 'pr']);

/** Built-ins that open app UI; the renderer handles them, so the session only explains when one arrives. */
export const UI_COMMANDS: ReadonlySet<string> = new Set(['model', 'mcp', 'resume', 'rewind', 'config', 'export', 'system', 'new', 'mission']);

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

/**
 * Custom commands from ~/.graft/commands and <project>/.graft/commands;
 * project wins on clashes. They can replace the prompt built-ins (/review,
 * /commit…) but not the ones that control the session or the app.
 */
export function loadCustomCommands(graftHome: string, projectRoot: string | null): CustomCommand[] {
  const byName = new Map<string, CustomCommand>();
  for (const c of scanCommands(path.join(graftHome, 'commands'), 'user')) byName.set(c.name, c);
  if (projectRoot) for (const c of scanCommands(path.join(projectRoot, '.graft', 'commands'), 'project')) byName.set(c.name, c);
  for (const name of BUILTIN_NAMES) if (!PROMPT_COMMANDS.has(name)) byName.delete(name);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Built-ins and custom commands as the "/" menu and /help show them: a custom command hides the built-in it replaces. */
export function listCommands(graftHome: string, projectRoot: string | null): SlashCommandInfo[] {
  const custom = loadCustomCommands(graftHome, projectRoot);
  const replaced = new Set(custom.map((c) => c.name));
  return [...BUILTIN_COMMANDS.filter((c) => !replaced.has(c.name)), ...custom.map(({ body: _body, ...info }) => info)];
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

function withFocus(parts: string[], focus: string, label = 'Focus especially on'): string {
  return [...parts, focus.length > 0 ? `${label}: ${focus}` : ''].join(' ').trim();
}

export function reviewPrompt(focus: string): string {
  return withFocus(
    [
      'Review the current uncommitted changes in this repository (use git status and git diff, including staged changes).',
      'Look for bugs, missed edge cases, security problems, race conditions, broken error handling and missing tests.',
      'Report findings ordered by severity with path:line references and a concrete fix for each. Say plainly if you find nothing significant.'
    ],
    focus
  );
}

export function securityReviewPrompt(focus: string): string {
  return withFocus(
    [
      'Do a security review of the current uncommitted changes in this repository (git status and git diff, staged changes included), reading the surrounding code where you need context.',
      'Look for injection (SQL, shell, path, template), broken authentication or authorization, secrets in code or logs, unsafe deserialization, SSRF, XSS, insecure defaults, missing input validation at trust boundaries, and risky dependencies.',
      'For each finding give the severity, path:line, how it could be exploited and a concrete fix. Only report real, specific issues; say plainly if you find none. Change nothing unless I ask.'
    ],
    focus
  );
}

export function explainPrompt(target: string): string {
  const what = target.length > 0 ? target : 'this project';
  return [
    `Explain how ${what} works.`,
    'Read the relevant code first. Start with a short overview, then walk through the main pieces and how data flows between them, with path:line references.',
    'Point out anything surprising or easy to get wrong. Don\'t change any files.'
  ].join(' ');
}

export function testPrompt(target: string): string {
  return target.length > 0
    ? `Write or improve tests for ${target}, following the project's existing test style and tools. Cover the important behavior and edge cases, run the tests, and fix any failures your tests uncover in the tests themselves; if one reveals a real bug, report it instead of changing the code under test.`
    : "Find how this project runs its tests (README, manifest, CI config), run them, and fix what fails. Fix the cause in the code or the test, whichever is wrong; never skip, delete or weaken a test to make it pass. Report what failed, why, and what you changed.";
}

/**
 * Decompilation as people do it with agents: one function at a time, each in
 * a fresh context, with the project's own match check as the judge and a limit
 * on attempts. The agent group's verify command is what makes a function count
 * only when the check passes.
 */
export function decompilePrompt(target: string): string {
  return [
    target.length > 0
      ? `Decompile ${target}: turn the compiled code into source that builds back to the same thing.`
      : 'This is a decompilation task: turning compiled code into source that builds back to the same thing. Look at what is here first, then ask me which function, file or binary to start with unless it is obvious.',
    'First learn how this project works: read its README and contributing notes, and find how it builds, how it checks a match (a Makefile or configure script, an objdiff or asm-differ setup, a progress script) and where the target assembly or binary lives. Use those commands exactly as the project gives them; do not invent a check of your own.',
    'If there is no project yet and you only have a binary, say so and propose a setup before decompiling anything. When a Ghidra server is connected (its tools start with mcp__ghidra__), use it to import the binary, list and decompile functions, follow cross-references and rename things as you learn what they are; Symbols outlines the C that is already written.',
    'Work one function at a time. For several functions, use RunAgents with one implementer for each: a fresh context, the function\'s target assembly and the source around it in its prompt, and the project\'s match check for that function as its verify command, so a function only counts once the check passes. Start with the smallest and simplest, and let later agents see what has already matched.',
    'For each function: read the target, write a first version, build, compare, then change one thing at a time towards the target. After about ten attempts without getting closer, stop, leave the best version marked as not matching, and say what still differs.',
    'Never edit the target assembly, the expected output, or the build and comparison tools to force a match, and never hide a difference. Keep names, types and layout consistent with the code already there.',
    'Report what matched, what did not and why, with the numbers the check itself prints. For a long job, suggest a mission (/mission) with the project\'s match check as what must pass.'
  ].join(' ');
}

export function commitPrompt(hint: string): string {
  return withFocus(
    [
      'Commit the current changes.',
      'First run git status, git diff (staged and unstaged) and git log -n 10 to see the changes and this repository\'s message style.',
      'Stage only the files that belong to the change; leave out unrelated files, generated output and anything that looks like a secret, and tell me if you left something out.',
      'Write a concise message in the repository\'s style: a summary line, then a short body that explains why when it isn\'t obvious. Don\'t push, amend or skip hooks; if a hook fails, fix the problem and commit again.'
    ],
    hint,
    'Notes for the message'
  );
}

export function prPrompt(hint: string): string {
  return withFocus(
    [
      'Open a pull request for the current work.',
      'Check git status, the diff against the base branch and the recent log. If you are on the default branch, create a new branch with a descriptive name first. Commit any uncommitted changes that belong to the work, the way a careful engineer would.',
      'Push the branch and open the pull request with the GitHub CLI (gh pr create), with a clear title and a body that covers what changed, why, and how it was tested. If gh isn\'t installed or signed in, stop and tell me what to run instead.',
      'Never force-push. Give me the pull request link at the end.'
    ],
    hint,
    'Notes for the pull request'
  );
}
