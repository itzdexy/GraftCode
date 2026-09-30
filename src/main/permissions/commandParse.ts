/**
 * Splits a shell command line into simple commands on ; && || | and newlines,
 * respecting quotes. Anything we can't reason about (substitutions,
 * backticks, heredocs, unbalanced quotes) marks the command as complex so it
 * is never auto-approved by prefix rules.
 */
export interface ParsedCommand {
  segments: string[];
  complex: boolean;
}

export function splitCommand(command: string): ParsedCommand {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let complex = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    const next = command[i + 1];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && next !== undefined) {
        current += ch + next;
        i++;
        continue;
      } else if (quote === '"' && (ch === '`' || (ch === '$' && next === '('))) complex = true;
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '\\' && next !== undefined) {
      current += ch + next;
      i++;
      continue;
    }
    if (ch === '`' || (ch === '$' && next === '(') || (ch === '<' && next === '<')) complex = true;
    const two = ch + (next ?? '');
    if (two === '&&' || two === '||') {
      segments.push(current);
      current = '';
      i++;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '\n' || ch === '&') {
      segments.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (quote) complex = true;
  segments.push(current);
  return { segments: segments.map((s) => s.trim()).filter((s) => s.length > 0), complex };
}

/** Splits one simple command into words (quotes removed). */
export function words(segment: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has || current.length > 0) out.push(current);
      current = '';
      has = false;
      continue;
    }
    current += ch;
    has = true;
  }
  if (has || current.length > 0) out.push(current);
  return out;
}

/** Leading VAR=value assignments and wrappers like `sudo`/`env` don't change what runs; strip them for matching. */
export function stripPrefixes(segment: string): string {
  let rest = segment.trim();
  for (;;) {
    const assignment = /^[A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|\S*)\s+/.exec(rest);
    if (assignment) {
      rest = rest.slice(assignment[0].length);
      continue;
    }
    const wrapper = /^(env|command|builtin|time|nice|nohup)\s+/.exec(rest);
    if (wrapper) {
      rest = rest.slice(wrapper[0].length);
      continue;
    }
    return rest;
  }
}
