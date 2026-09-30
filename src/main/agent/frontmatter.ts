/**
 * Minimal front matter reader for command and skill files:
 *   ---
 *   description: Run the release checklist
 *   argument-hint: "<version>"
 *   ---
 * Only flat `key: value` pairs are supported; values may be quoted.
 */
export function parseFrontmatter(text: string): { data: Record<string, string>; body: string } {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(clean);
  if (!match) return { data: {}, body: clean };
  const data: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    let value = kv[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    data[kv[1]!.toLowerCase()] = value;
  }
  return { data, body: clean.slice(match[0].length) };
}

/** First non-heading paragraph, for descriptions of files without front matter. */
export function firstParagraph(body: string, max = 160): string {
  const para = body
    .split(/\r?\n\r?\n/)
    .map((p) => p.trim())
    .find((p) => p.length > 0 && !p.startsWith('#'));
  if (!para) return '';
  const flat = para.replace(/\s+/g, ' ');
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
