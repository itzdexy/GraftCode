import { createHash } from 'node:crypto';

/** Tool names must match ^[A-Za-z][A-Za-z0-9_]{0,63}$ for every provider. */
export function mcpToolName(server: string, tool: string): string {
  const clean = (s: string): string => s.replace(/[^A-Za-z0-9_]/g, '_');
  const full = `mcp__${clean(server)}__${clean(tool)}`;
  if (full.length <= 64) return full;
  const hash = createHash('sha256').update(`${server}/${tool}`).digest('hex').slice(0, 6);
  return `${full.slice(0, 57)}_${hash}`;
}

/** The slash command that runs a server's prompt: named like a tool of that server, in the lower case the command line reads. */
export function mcpPromptCommand(server: string, prompt: string): string {
  return mcpToolName(server, prompt).toLowerCase();
}

/**
 * What was typed after a prompt's command, as that prompt's arguments: one word
 * for each in turn, with the last taking the rest of the line so free text
 * needs no quotes.
 */
export function promptArguments(text: string, names: string[]): Record<string, string> {
  const words = text.trim().length > 0 ? text.trim().split(/\s+/) : [];
  const values: Record<string, string> = {};
  names.forEach((name, i) => {
    if (i < names.length - 1) {
      if (words[i] !== undefined) values[name] = words[i]!;
    } else if (words.length > i) {
      values[name] = words.slice(i).join(' ');
    }
  });
  return values;
}

/** "<file> [focus]": what follows a prompt's command, required arguments in angle brackets. */
export function promptHint(prompt: { arguments: Array<{ name: string; required: boolean }> }): string {
  return prompt.arguments.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(' ');
}
