import { describe, expect, it } from 'vitest';
import { decide, type PermissionEnv, type PermissionQuery } from '../../src/main/permissions/engine';
import { parseRule } from '../../src/main/permissions/rules';
import { mcpToolName } from '../../src/main/mcp/names';
import { effectivePolicy, mcpServerRule, policyOf, withPolicy, type ToolPolicy } from '../../src/shared/mcpPolicy';
import type { PermissionMode } from '../../src/shared/schemas/common';
import type { RuleLists } from '../../src/shared/schemas/system';

const NONE: RuleLists = { allow: [], ask: [], deny: [] };
const TOOL = 'mcp__gh__create_issue';

describe('what the rules say about a tool of an MCP server', () => {
  it('reads the tool’s own rule, the strictest list first', () => {
    expect(policyOf(NONE, TOOL)).toBe('default');
    expect(policyOf({ ...NONE, allow: [TOOL] }, TOOL)).toBe('allow');
    expect(policyOf({ allow: [TOOL], ask: [TOOL], deny: [] }, TOOL)).toBe('ask');
    expect(policyOf({ allow: [TOOL], ask: [TOOL], deny: [TOOL] }, TOOL)).toBe('deny');
    // Other tools and other kinds of rule say nothing about this one.
    expect(policyOf({ allow: ['Shell(npm test:*)'], ask: [], deny: ['mcp__gh__delete_repo', 'mcp__gh'] }, TOOL)).toBe('default');
  });

  it('sets one policy for a tool, takes it out of the other lists, and leaves every other rule where it was', () => {
    const before: RuleLists = { allow: ['Shell(npm test:*)', TOOL], ask: ['mcp__gh__close_issue'], deny: ['Read(~/.ssh/**)'] };
    expect(withPolicy(before, TOOL, 'deny')).toEqual({ allow: ['Shell(npm test:*)'], ask: ['mcp__gh__close_issue'], deny: ['Read(~/.ssh/**)', TOOL] });
    expect(withPolicy(before, TOOL, 'ask')).toEqual({ allow: ['Shell(npm test:*)'], ask: ['mcp__gh__close_issue', TOOL], deny: ['Read(~/.ssh/**)'] });
    expect(withPolicy(before, TOOL, 'default')).toEqual({ allow: ['Shell(npm test:*)'], ask: ['mcp__gh__close_issue'], deny: ['Read(~/.ssh/**)'] });
    // Already so: nothing moves and nothing is added twice.
    expect(withPolicy(before, TOOL, 'allow')).toEqual(before);
    expect(before.allow).toEqual(['Shell(npm test:*)', TOOL]);
  });

  it('names the rule for a whole server the way that server’s tools are named', () => {
    expect(mcpServerRule('github')).toBe('mcp__github');
    expect(mcpServerRule('my server.v2')).toBe('mcp__my_server_v2');
    for (const server of ['github', 'my server.v2', 'ünïcode']) expect(mcpToolName(server, 'a').startsWith(`${mcpServerRule(server)}__`)).toBe(true);
  });

  it('lets the stricter of a tool’s rule and its server’s decide', () => {
    expect(effectivePolicy({ ...NONE, allow: ['mcp__gh'] }, TOOL)).toBe('allow');
    expect(effectivePolicy({ allow: [TOOL], ask: ['mcp__gh'], deny: [] }, TOOL)).toBe('ask');
    expect(effectivePolicy({ allow: ['mcp__gh'], ask: [], deny: [TOOL] }, TOOL)).toBe('deny');
    expect(effectivePolicy({ allow: ['mcp__other'], ask: [], deny: [] }, TOOL)).toBe('default');
  });
});

describe('a policy set for a tool, as the permission rules apply it', () => {
  const env = (mode: PermissionMode, lists: RuleLists): PermissionEnv => ({
    mode,
    projectRoot: process.cwd(),
    platform: process.platform,
    rules: { allow: lists.allow.map((r) => parseRule(r, 'user')!), ask: lists.ask.map((r) => parseRule(r, 'user')!), deny: lists.deny.map((r) => parseRule(r, 'user')!) }
  });
  /** A tool whose server says it changes nothing, which Auto mode takes at its word. */
  const says = (readOnly: boolean): PermissionQuery => ({ toolName: TOOL, permissionClass: 'network', descriptor: { summary: 'mcp' }, mcp: { readOnly, destructive: false } });
  const outcome = (policy: ToolPolicy, mode: PermissionMode, readOnly = false): string => decide(says(readOnly), env(mode, withPolicy(NONE, TOOL, policy))).behavior;

  it('never runs a tool set to Never, in any mode', () => {
    for (const mode of ['ask', 'auto-edit', 'auto', 'plan', 'bypass'] as const) expect(outcome('deny', mode, true), mode).toBe('deny');
  });

  it('asks for a tool set to Ask even where its server’s word would have let it through', () => {
    // The server calls the tool read-only: Auto mode runs it unasked. The user's rule is not a hint.
    expect(outcome('default', 'auto', true)).toBe('allow');
    expect(outcome('ask', 'auto', true)).toBe('ask');
    expect(outcome('ask', 'ask')).toBe('ask');
  });

  it('runs a tool set to Allow without asking, and leaves the others asking', () => {
    expect(outcome('allow', 'ask')).toBe('allow');
    expect(outcome('default', 'ask')).toBe('ask');
    expect(decide({ ...says(false), toolName: 'mcp__gh__delete_repo' }, env('ask', withPolicy(NONE, TOOL, 'allow'))).behavior).toBe('ask');
  });

  it('agrees with what the screen shows for every mix of a tool’s rule and its server’s', () => {
    const shown: Record<ToolPolicy, string> = { deny: 'deny', ask: 'ask', allow: 'allow', default: 'ask' };
    for (const tool of ['default', 'ask', 'allow', 'deny'] as const) {
      for (const server of ['default', 'ask', 'allow', 'deny'] as const) {
        const lists = withPolicy(withPolicy(NONE, TOOL, tool), 'mcp__gh', server);
        expect(decide(says(false), env('ask', lists)).behavior, `tool ${tool}, server ${server}`).toBe(shown[effectivePolicy(lists, TOOL)]);
      }
    }
  });
});
