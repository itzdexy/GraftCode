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

function metaAttribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : null;
}

/** Which <meta> names a page's picture, the most trusted first. */
const IMAGE_META = ['og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src'];
const MAX_IMAGE_URL = 2000;

/**
 * The picture a page offers for links to it (Open Graph, else Twitter card),
 * as an https address; null when it names none. Only the <head> is read.
 */
export function extractImage(html: string, baseUrl: string): string | null {
  const end = html.search(/<\/head>/i);
  const named = new Map<string, string>();
  for (const tag of (end === -1 ? html.slice(0, 200_000) : html.slice(0, end)).match(/<meta\b[^>]*>/gi) ?? []) {
    const name = (metaAttribute(tag, 'property') ?? metaAttribute(tag, 'name') ?? '').toLowerCase();
    const content = metaAttribute(tag, 'content');
    if (content && IMAGE_META.includes(name) && !named.has(name)) named.set(name, decodeEntities(content.trim()));
  }
  for (const name of IMAGE_META) {
    const value = named.get(name);
    if (!value) continue;
    try {
      const url = new URL(value, baseUrl);
      if (url.protocol === 'https:' && url.href.length <= MAX_IMAGE_URL) return url.href;
    } catch {
      // Not an address: the next name may hold one.
    }
  }
  return null;
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
