import os from 'node:os';
import path from 'node:path';
import picomatch from 'picomatch';
import { splitCommand } from './commandParse';

export type RuleSource = 'user' | 'project' | 'local' | 'session';

export interface Rule {
  raw: string;
  tool: string;
  content: string | null;
  source: RuleSource;
}

export interface RuleTarget {
  toolName: string;
  command?: string | undefined;
  reads?: string[] | undefined;
  writes?: string[] | undefined;
  url?: string | undefined;
}

export interface MatchEnv {
  projectRoot: string;
  platform: NodeJS.Platform;
  home?: string;
}

const RULE = /^([A-Za-z][A-Za-z0-9_]*)(?:\((.*)\))?$/s;

/** Tool families: a rule on the family name covers every member. */
const FAMILIES: Record<string, string[]> = {
  Read: ['Read', 'Glob', 'Grep'],
  Edit: ['Edit', 'MultiEdit', 'Write'],
  Write: ['Edit', 'MultiEdit', 'Write'],
  Shell: ['Shell'],
  Bash: ['Shell'],
  PowerShell: ['Shell']
};

export function parseRule(raw: string, source: RuleSource): Rule | null {
  const match = RULE.exec(raw.trim());
  if (!match) return null;
  const content = match[2]?.trim();
  return { raw: raw.trim(), tool: match[1]!, content: content === undefined || content === '' || content === '*' ? null : content, source };
}

function coversTool(rule: Rule, toolName: string): boolean {
  if (rule.tool.startsWith('mcp__')) {
    if (rule.tool === toolName) return true;
    const parts = rule.tool.split('__');
    return parts.length === 2 && toolName.startsWith(`${rule.tool}__`);
  }
  const family = FAMILIES[rule.tool];
  return family ? family.includes(toolName) : rule.tool === toolName;
}

function commandMatches(pattern: string, segment: string): boolean {
  const cmd = segment.trim().replace(/\s+/g, ' ');
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -2).trim().replace(/\s+/g, ' ');
    return cmd === prefix || cmd.startsWith(`${prefix} `);
  }
  if (pattern.includes('*')) {
    const re = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 's');
    return re.test(cmd);
  }
  return cmd === pattern.trim().replace(/\s+/g, ' ');
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Splits a rule pattern into the directory it is anchored to and the glob
 * relative to it. Matching relative paths keeps characters in real folder
 * names (spaces, parentheses, brackets) from being read as glob syntax.
 */
function anchor(pattern: string, env: MatchEnv): { base: string | null; glob: string } {
  const home = env.home ?? os.homedir();
  if (pattern === '~') return { base: home, glob: '' };
  if (pattern.startsWith('~/') || pattern.startsWith('~\\')) return { base: home, glob: toPosix(pattern.slice(2)) };
  if (pattern.startsWith('//')) return { base: null, glob: pattern.slice(1) };
  if (path.isAbsolute(pattern) || /^[A-Za-z]:[\\/]/.test(pattern)) return { base: null, glob: toPosix(pattern) };
  return { base: env.projectRoot, glob: toPosix(pattern).replace(/^\.\//, '') };
}

function pathMatches(pattern: string, target: string, env: MatchEnv): boolean {
  const nocase = env.platform === 'win32';
  const { base, glob } = anchor(pattern, env);
  const absolute = path.resolve(target);
  let candidate: string;
  if (base === null) {
    candidate = toPosix(absolute);
  } else {
    const rel = path.relative(base, absolute);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
    candidate = toPosix(rel);
  }
  if (glob === '') return true;
  if (!/[*?[\]{}]/.test(glob)) {
    const a = nocase ? glob.toLowerCase().replace(/\/$/, '') : glob.replace(/\/$/, '');
    const b = nocase ? candidate.toLowerCase() : candidate;
    return b === a || b.startsWith(`${a}/`);
  }
  return picomatch(glob, { dot: true, nocase })(candidate);
}

function hostMatches(content: string, url: string | undefined): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (content.startsWith('domain:')) {
    const domain = content.slice(7).trim().toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  }
  return url.startsWith(content);
}

/**
 * Whether a rule covers a call. `mode` controls compound targets:
 * "allow" needs every command segment / path to match (so an allow rule can
 * never smuggle in a second command); "restrict" (deny/ask) needs just one.
 */
export function ruleMatches(rule: Rule, target: RuleTarget, env: MatchEnv, mode: 'allow' | 'restrict'): boolean {
  if (!coversTool(rule, target.toolName)) return false;
  if (rule.content === null) return true;
  const content = rule.content;
  if (target.command !== undefined) {
    const { segments, complex } = splitCommand(target.command);
    if (mode === 'allow') {
      if (complex) return commandMatches(content, target.command);
      return segments.length > 0 && segments.every((s) => commandMatches(content, s));
    }
    return commandMatches(content, target.command) || segments.some((s) => commandMatches(content, s));
  }
  if (target.url !== undefined) return hostMatches(content, target.url);
  const paths = [...(target.reads ?? []), ...(target.writes ?? [])];
  if (paths.length === 0) return false;
  return mode === 'allow' ? paths.every((p) => pathMatches(content, p, env)) : paths.some((p) => pathMatches(content, p, env));
}
