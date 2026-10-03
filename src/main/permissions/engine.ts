import os from 'node:os';
import path from 'node:path';
import type { PermissionMode } from '@shared/schemas/common';
import { isInside, isInsideReal } from '../tools/paths';
import type { PermissionClass, ToolCallDescriptor } from '../tools/types';
import { splitCommand, stripPrefixes, words } from './commandParse';
import { classifyCommand, outsidePaths } from './commandRisk';
import { dangerousCommand, isCredentialPath } from './dangerous';
import { ruleMatches, type Rule, type RuleTarget } from './rules';

export interface PermissionQuery {
  toolName: string;
  permissionClass: PermissionClass;
  descriptor: ToolCallDescriptor;
  /** MCP tool annotations, when the call targets an MCP server. */
  mcp?: { readOnly: boolean; destructive: boolean };
}

export interface RuleSet {
  allow: Rule[];
  ask: Rule[];
  deny: Rule[];
}

export interface PermissionEnv {
  mode: PermissionMode;
  projectRoot: string;
  platform: NodeJS.Platform;
  home?: string;
  rules: RuleSet;
  /** In Bypass, still ask before dangerous commands, writes outside the project and config changes (Settings → Permissions). */
  bypassKeepsChecks?: boolean;
  /** Chats search and read the web without asking (deny and ask rules still apply). */
  allowNetwork?: boolean;
  /** Commands run in the session's sandbox container, which reaches nothing outside the project folder. */
  sandboxed?: boolean;
}

export interface Decision {
  behavior: 'allow' | 'ask' | 'deny';
  reason: string;
  dangerous: string | null;
  outsideProject: boolean;
  suggestedRule: string | null;
}

/** Files that control Graft or git itself: writing them always needs a person. */
const PROTECTED_IN_PROJECT = ['.graft/settings.json', '.graft/settings.local.json', '.graft/hooks', '.git/hooks', '.git/config'];
const PROTECTED_MENTION = /(\.graft[\\/](settings(\.local)?\.json|hooks)|\.git[\\/](hooks|config)\b)/i;

/** An address served from this computer (a dev server), as typed or with a scheme. */
export function isLocalUrl(raw: string): boolean {
  const input = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw.trim()) ? raw.trim() : `http://${raw.trim()}`;
  try {
    const host = new URL(input).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '0.0.0.0' || host.endsWith('.localhost');
  } catch {
    return false;
  }
}

function isProtected(p: string, root: string, platform: NodeJS.Platform): boolean {
  return PROTECTED_IN_PROJECT.some((rel) => {
    const target = path.join(root, rel);
    return isInside(target, p, platform);
  });
}

export function suggestRule(query: PermissionQuery, env: PermissionEnv): string | null {
  const d = query.descriptor;
  if (query.toolName.startsWith('mcp__')) return query.toolName;
  if (d.command !== undefined) {
    const { segments, complex } = splitCommand(d.command);
    if (complex || segments.length !== 1) return null;
    const w = words(stripPrefixes(segments[0]!));
    if (w.length === 0) return null;
    const second = w[1];
    const prefix = second && /^[a-z][\w:-]*$/i.test(second) && !second.startsWith('-') ? `${w[0]} ${second}` : w[0]!;
    return `Shell(${prefix}:*)`;
  }
  if (d.url !== undefined) {
    try {
      return `${query.toolName}(domain:${new URL(d.url).hostname})`;
    } catch {
      return null;
    }
  }
  const paths = [...(d.writes ?? []), ...(d.reads ?? [])];
  const first = paths[0];
  if (!first) return query.permissionClass === 'none' ? null : query.toolName;
  const family = query.permissionClass === 'write' ? 'Edit' : 'Read';
  if (isInside(env.projectRoot, first, env.platform)) {
    const dir = path.relative(env.projectRoot, path.dirname(first)).split(path.sep).join('/');
    return `${family}(${dir.length > 0 ? `${dir}/**` : '**'})`;
  }
  return family === 'Read' ? `Read(${path.dirname(first).split(path.sep).join('/')}/**)` : null;
}

/**
 * Decides whether a tool call runs, asks the user, or is refused.
 * Order: deny rules → plan-mode limits → never-automatic conditions
 * (dangerous, writes outside the project, protected config) → ask rules →
 * allow rules → the mode's defaults.
 */
export function decide(query: PermissionQuery, env: PermissionEnv): Decision {
  const { descriptor: d, permissionClass: cls } = query;
  const home = env.home ?? os.homedir();
  const matchEnv = { projectRoot: env.projectRoot, platform: env.platform, home };
  const target: RuleTarget = { toolName: query.toolName, command: d.command, reads: d.reads, writes: d.writes, url: d.url };
  const reads = d.reads ?? [];
  const writes = d.writes ?? [];
  const outsideReads = reads.filter((p) => !isInsideReal(env.projectRoot, p, env.platform));
  const outsideWrites = writes.filter((p) => !isInsideReal(env.projectRoot, p, env.platform));
  const outsideCommand = d.command !== undefined ? outsidePaths(d.command, env.projectRoot, env.platform, home) : [];
  const outsideProject = outsideReads.length + outsideWrites.length + outsideCommand.length > 0;

  let dangerous: string | null = d.command !== undefined ? dangerousCommand(d.command) : null;
  if (!dangerous && [...reads, ...writes].some((p) => isCredentialPath(p))) dangerous = 'Accesses credentials or secrets';
  if (!dangerous && query.mcp?.destructive) dangerous = 'The tool says it can make destructive changes';
  const protectedHit =
    writes.some((p) => isProtected(p, env.projectRoot, env.platform)) || (d.command !== undefined && PROTECTED_MENTION.test(d.command));

  const suggestion = dangerous || outsideWrites.length > 0 || protectedHit ? null : suggestRule(query, env);
  const result = (behavior: Decision['behavior'], reason: string): Decision => ({
    behavior,
    reason,
    dangerous,
    outsideProject,
    suggestedRule: behavior === 'ask' ? suggestion : null
  });

  const deny = env.rules.deny.find((r) => ruleMatches(r, target, matchEnv, 'restrict'));
  if (deny) return result('deny', `Blocked by the rule ${deny.raw} (${deny.source} settings).`);

  const mcpReadOnly = query.mcp?.readOnly === true;
  if (env.mode === 'plan') {
    const planBlock = 'Plan mode is read-only. Finish researching, then present the plan with ExitPlanMode.';
    if (cls === 'write') return result('deny', planBlock);
    if (cls === 'exec') {
      const readOnly = d.command !== undefined && classifyCommand(d.command) === 'read-only';
      if (!readOnly || dangerous || outsideProject) return result('deny', planBlock);
    }
    if (query.mcp && !mcpReadOnly) return result('deny', planBlock);
    if (cls === 'computer') return result('deny', planBlock);
    // Clicking and typing in a page can change the app behind it; reading it can't.
    if (d.page === 'act') return result('deny', planBlock);
  }

  // Bypass runs everything without prompts (deny rules above still apply), unless the user kept the safety checks on.
  if (env.mode === 'bypass' && !env.bypassKeepsChecks) return result('allow', 'Bypass mode.');

  if (dangerous) return result('ask', dangerous);
  if (outsideWrites.length > 0) return result('ask', 'Writes outside the project folder.');
  if (protectedHit) return result('ask', 'Changes Graft or git configuration.');

  const ask = env.rules.ask.find((r) => ruleMatches(r, target, matchEnv, 'restrict'));
  if (ask) return result('ask', `The rule ${ask.raw} requires approval.`);
  const allow = env.rules.allow.find((r) => ruleMatches(r, target, matchEnv, 'allow'));
  if (allow) return result('allow', `Allowed by the rule ${allow.raw}.`);
  // The page was opened with permission (or is local); working with it stays inside that page.
  if (d.page) return result('allow', 'Works on the page already open in the browser.');

  const mode = env.mode;
  if (query.mcp) {
    // Annotations come from the server and are only hints: they relax approval in Auto mode, never in Ask.
    if (mcpReadOnly && !outsideProject && mode === 'auto') return result('allow', 'Read-only tool allowed in Auto mode.');
    if (mode === 'bypass') return result('allow', 'Bypass mode.');
    return result('ask', `Uses ${query.toolName.split('__')[1] ?? 'an MCP server'}.`);
  }
  switch (cls) {
    case 'none':
      return result('allow', 'No side effects outside the conversation.');
    case 'read':
      if (outsideReads.length === 0) return result('allow', 'Reads inside the project.');
      return mode === 'bypass' ? result('allow', 'Bypass mode.') : result('ask', 'Reads outside the project folder.');
    case 'write':
      if (mode === 'auto-edit' || mode === 'auto' || mode === 'bypass') return result('allow', 'Edits inside the project are allowed in this mode.');
      return result('ask', 'Edits need approval in Ask mode.');
    case 'exec': {
      const risk = d.command !== undefined ? classifyCommand(d.command) : 'unknown';
      if (risk === 'read-only' && !outsideProject) return result('allow', 'Read-only command.');
      if (mode === 'bypass') return result('allow', 'Bypass mode.');
      // In the sandbox a command reaches the project folder and nothing else, like an edit does. Paths
      // outside the project name the container's own files there. Dangerous commands still asked above.
      if (env.sandboxed && (mode === 'auto-edit' || mode === 'auto')) return result('allow', 'Runs in the sandbox, which only reaches the project folder.');
      if (mode === 'auto' && risk === 'low' && !outsideProject) return result('allow', 'Low-risk command allowed in Auto mode.');
      return result('ask', outsideProject ? 'The command refers to paths outside the project.' : 'Runs a command.');
    }
    case 'computer':
      return result('ask', 'Uses your screen, mouse and keyboard.');
    case 'network':
      if (env.allowNetwork) return result('allow', 'Chats may search and read the web.');
      if (mode === 'auto' || mode === 'bypass') return result('allow', 'Network reads are allowed in this mode.');
      // The user's own dev server: opening it in the browser has the reach of an edit.
      if (mode === 'auto-edit' && query.toolName === 'Browser' && d.url !== undefined && isLocalUrl(d.url)) {
        return result('allow', 'Opens a page served from this computer.');
      }
      return result('ask', query.toolName === 'Browser' ? 'Opens a web page.' : 'Fetches from the network.');
  }
}
