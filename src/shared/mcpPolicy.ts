import type { RuleLists } from './schemas/system';

/**
 * What the user decided about one tool of an MCP server, or about every tool of a server.
 * Stored as permission rules under the name the agent calls the tool by (mcp__server__tool,
 * or mcp__server for all of them): the same rules Settings → Permissions shows, so there is
 * one place where a call is decided. "default" is no rule: the permission mode decides.
 */
export type ToolPolicy = 'default' | 'ask' | 'allow' | 'deny';

/** The rule that covers every tool of a server. Cleaned as tool names are (see main/mcp/names.ts). */
export function mcpServerRule(server: string): string {
  return `mcp__${server.replace(/[^A-Za-z0-9_]/g, '_')}`;
}

/** What the lists say about a rule name itself, the strictest first: that is the order the rules are applied in. */
export function policyOf(rules: RuleLists, name: string): ToolPolicy {
  if (rules.deny.includes(name)) return 'deny';
  if (rules.ask.includes(name)) return 'ask';
  if (rules.allow.includes(name)) return 'allow';
  return 'default';
}

/** The lists with `name` under one policy and in no other list; every other rule stays where it is. */
export function withPolicy(rules: RuleLists, name: string, policy: ToolPolicy): RuleLists {
  const without = (list: string[]): string[] => list.filter((rule) => rule !== name);
  const next: RuleLists = { allow: without(rules.allow), ask: without(rules.ask), deny: without(rules.deny) };
  if (policy === 'default') return next;
  // Put back where it was when nothing changes, so a list is not reordered by looking at it.
  if (policyOf(rules, name) === policy && [rules.allow, rules.ask, rules.deny].filter((list) => list.includes(name)).length === 1) return rules;
  next[policy] = [...next[policy], name];
  return next;
}

const STRICTNESS: Record<ToolPolicy, number> = { deny: 3, ask: 2, allow: 1, default: 0 };

/** What happens to a tool: its own rule or its server's, whichever is stricter. */
export function effectivePolicy(rules: RuleLists, registeredAs: string): ToolPolicy {
  const own = policyOf(rules, registeredAs);
  const parts = registeredAs.split('__');
  const server = parts.length >= 3 ? policyOf(rules, `${parts[0]!}__${parts[1]!}`) : 'default';
  return STRICTNESS[own] >= STRICTNESS[server] ? own : server;
}
