const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  copy: '©',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“'
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match: string, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const cp = parseInt(body.slice(2), 16);
      return Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    }
    if (body.startsWith('#')) {
      const cp = parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

export function extractTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m?.[1] ? decodeEntities(m[1].replace(/\s+/g, ' ').trim()) || null : null;
}

/**
 * Converts HTML to readable Markdown-ish text: drops scripts/styles, keeps
 * headings, links, list items, code blocks and paragraph breaks.
 */
export function htmlToText(html: string, baseUrl?: string): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m: string, body: string) => `\n\`\`\`\n${body.replace(/<[^>]+>/g, '')}\n\`\`\`\n`);
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m: string, level: string, body: string) => `\n\n${'#'.repeat(Number(level))} ${body.replace(/<[^>]+>/g, '').trim()}\n\n`);
  s = s.replace(/<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi, (_m: string, _q: string, d: string | undefined, sq: string | undefined, bare: string | undefined, text: string) => {
    const href = d ?? sq ?? bare ?? '';
    const label = text.replace(/<[^>]+>/g, '').trim();
    if (!label) return '';
    let resolved: string;
    try {
      resolved = baseUrl ? new URL(href, baseUrl).href : href;
    } catch {
      resolved = href;
    }
    return /^(https?:|mailto:)/i.test(resolved) ? `[${label}](${resolved})` : label;
  });
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<(br|hr)\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|section|article|header|footer|li|ul|ol|table|tr|blockquote|main|nav|aside|form|h[1-6])>/gi, '\n\n');
  s = s.replace(/<(td|th)\b[^>]*>/gi, ' | ');
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m: string, body: string) => `\`${body}\``);
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  s = s.replace(/[ \t\f\v]+/g, ' ');
  s = s
    .split('\n')
    .map((l) => l.trim())
    .join('\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}
