import { nativeImage } from 'electron';

/**
 * Site icons for web-search results. Hosts come from untrusted results, so
 * only public-looking names are fetched, over https, small and briefly.
 * Bitmaps are decoded and re-encoded as 32px PNG data URLs; SVG icons go to
 * the renderer as SVG data URLs, which images display without running any
 * script. Tries /favicon.ico, then the icon the home page declares, then
 * /apple-touch-icon.png. Results (including misses) are cached.
 */
const MAX_BYTES = 200 * 1024;
const MAX_PAGE_BYTES = 300 * 1024;
const TIMEOUT_MS = 5000;
const CACHE_LIMIT = 500;

const cache = new Map<string, string | null>();
const pending = new Map<string, Promise<string | null>>();

const HOSTNAME = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/;
const PRIVATE_SUFFIX = /\.(local|localhost|internal|lan|home|corp|intranet|test|invalid|example)$/;

/** A public DNS name: no IP literals, no single-label or private-use names. */
export function isPublicHost(host: string): boolean {
  const h = host.toLowerCase();
  return HOSTNAME.test(h) && !PRIVATE_SUFFIX.test(h);
}

function publicHttps(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && isPublicHost(u.hostname);
  } catch {
    return false;
  }
}

async function get(url: string, accept: string, limit: number): Promise<{ buffer: Buffer; type: string; url: string } | null> {
  if (!publicHttps(url)) return null;
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept, 'user-agent': 'Graft/1.0 (+desktop coding agent)' } });
  if (!response.ok || !publicHttps(response.url)) return null;
  if (Number(response.headers.get('content-length') ?? 0) > limit) return null;
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0 || buffer.length > limit) return null;
  return { buffer, type: response.headers.get('content-type') ?? '', url: response.url };
}

/** An image as a data URL the renderer can show, or null when it isn't one. */
export function iconDataUrl(buffer: Buffer, type: string): string | null {
  const head = buffer.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
  if (/svg/i.test(type) || head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) {
    return `data:image/svg+xml;base64,${buffer.toString('base64')}`;
  }
  if (type && !/^image\//i.test(type) && !/octet-stream/i.test(type)) return null;
  const image = nativeImage.createFromBuffer(buffer);
  return image.isEmpty() ? null : image.resize({ width: 32, height: 32, quality: 'best' }).toDataURL();
}

/** The icon a page's <head> declares, resolved against the page's address. */
export function declaredIcon(html: string, pageUrl: string): string | null {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? '';
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href || !/(^|\s)(icon|shortcut icon|apple-touch-icon)(\s|$)/.test(rel)) continue;
    try {
      return new URL(href, pageUrl).toString();
    } catch {
      // A malformed href: try the next link.
    }
  }
  return null;
}

async function fetchIcon(host: string): Promise<string | null> {
  const attempts: Array<() => Promise<string | null>> = [
    async () => {
      const file = await get(`https://${host}/favicon.ico`, 'image/*', MAX_BYTES);
      return file ? iconDataUrl(file.buffer, file.type) : null;
    },
    async () => {
      const page = await get(`https://${host}/`, 'text/html', MAX_PAGE_BYTES);
      const href = page ? declaredIcon(page.buffer.toString('utf8'), page.url) : null;
      const file = href ? await get(href, 'image/*', MAX_BYTES) : null;
      return file ? iconDataUrl(file.buffer, file.type) : null;
    },
    async () => {
      const file = await get(`https://${host}/apple-touch-icon.png`, 'image/*', MAX_BYTES);
      return file ? iconDataUrl(file.buffer, file.type) : null;
    }
  ];
  for (const attempt of attempts) {
    try {
      const icon = await attempt();
      if (icon) return icon;
    } catch {
      // Unreachable, slow or undecodable: try the next source.
    }
  }
  return null;
}

export function favicon(host: string): Promise<string | null> {
  const key = host.toLowerCase();
  if (!isPublicHost(key)) return Promise.resolve(null);
  if (cache.has(key)) return Promise.resolve(cache.get(key) ?? null);
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  const job = fetchIcon(key).then((icon) => {
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
    cache.set(key, icon);
    pending.delete(key);
    return icon;
  });
  pending.set(key, job);
  return job;
}
