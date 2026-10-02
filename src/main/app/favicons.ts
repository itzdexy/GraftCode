import { nativeImage, net } from 'electron';
import { icoToPng, isIco } from './ico';

/**
 * Site icons for web-search results. Hosts come from untrusted results, so
 * only public-looking names are fetched, over https, small and briefly, with
 * Chromium's network stack (sites that turn away scripted clients serve it)
 * and without cookies. Bitmaps (PNG and JPEG, and .ico files converted first)
 * are decoded and re-encoded as 32px PNG data URLs; SVG icons go to the
 * renderer as SVG data URLs, which images display without running any script.
 * Tries /favicon.ico, then the best icons the home page declares, then
 * /apple-touch-icon.png. Results (including misses) are cached.
 */
/** Multi-size .ico files reach a few hundred KB. */
const MAX_BYTES = 512 * 1024;
/** Home pages are read only this far: the icon links sit in the <head>, near the top. */
const PAGE_BYTES = 256 * 1024;
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

type Download = { buffer: Buffer; type: string; url: string };

/**
 * A small https file. Each redirect must stay on a public https host (at most
 * five). `partial` keeps the first `limit` bytes of a larger file instead of
 * giving up.
 */
function get(url: string, accept: string, limit: number, partial = false): Promise<Download | null> {
  return new Promise((resolve) => {
    if (!publicHttps(url)) {
      resolve(null);
      return;
    }
    let current = url;
    let hops = 0;
    let settled = false;
    const request = net.request({ url, redirect: 'manual', credentials: 'omit', useSessionCookies: false });
    const finish = (download: Download | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(download);
    };
    const stop = (download: Download | null): void => {
      finish(download);
      request.abort();
    };
    const timer = setTimeout(() => stop(null), TIMEOUT_MS);
    request.setHeader('accept', accept);
    request.on('redirect', (_status, _method, location) => {
      hops += 1;
      if (hops > 5 || !publicHttps(location)) return stop(null);
      current = location;
      request.followRedirect();
    });
    request.on('response', (response) => {
      const header = response.headers['content-type'];
      const type = (Array.isArray(header) ? header[0] : header) ?? '';
      if (response.statusCode < 200 || response.statusCode >= 300) return stop(null);
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        size += chunk.length;
        if (size > limit) stop(partial ? { buffer: Buffer.concat(chunks).subarray(0, limit), type, url: current } : null);
      });
      response.on('end', () => finish(size > 0 ? { buffer: Buffer.concat(chunks), type, url: current } : null));
      response.on('error', () => finish(null));
    });
    request.on('error', () => finish(null));
    request.end();
  });
}

/** An image as a data URL the renderer can show, or null when it isn't one. Servers often mislabel icons, so the bytes decide. */
export function iconDataUrl(buffer: Buffer, type: string): string | null {
  const head = buffer.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
  if (/svg/i.test(type) || head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) {
    return `data:image/svg+xml;base64,${buffer.toString('base64')}`;
  }
  if (/^text\//i.test(type) || head.startsWith('<')) return null;
  const png = isIco(buffer) ? icoToPng(buffer) : buffer;
  if (!png) return null;
  const image = nativeImage.createFromBuffer(png);
  return image.isEmpty() ? null : image.resize({ width: 32, height: 32, quality: 'best' }).toDataURL();
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : null;
}

/**
 * The icons a page's <head> declares, best first: SVG, then bitmaps from
 * 32px up (smallest first), then smaller or unsized ones, then .ico files.
 */
export function declaredIcons(html: string, pageUrl: string): string[] {
  const end = html.search(/<\/head>/i);
  const found: Array<{ url: string; rank: number }> = [];
  for (const tag of (end === -1 ? html : html.slice(0, end)).match(/<link\b[^>]*>/gi) ?? []) {
    const rel = (attribute(tag, 'rel') ?? '').toLowerCase().split(/\s+/);
    const href = attribute(tag, 'href');
    if (!href || !rel.some((r) => r === 'icon' || r === 'apple-touch-icon' || r === 'apple-touch-icon-precomposed')) continue;
    let url: URL;
    try {
      url = new URL(href.replace(/&amp;/g, '&'), pageUrl);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'data:') continue;
    const type = (attribute(tag, 'type') ?? '').toLowerCase();
    const sizes = (attribute(tag, 'sizes') ?? '').toLowerCase();
    const px = Math.max(0, ...[...sizes.matchAll(/(\d+)x\d+/g)].map((m) => Number(m[1])));
    const path = url.protocol === 'data:' ? url.href.slice(0, 40) : url.pathname.toLowerCase();
    const svg = type.includes('svg') || sizes === 'any' || path.endsWith('.svg') || path.startsWith('data:image/svg');
    const ico = type.includes('icon') || path.endsWith('.ico');
    const rank = svg ? 0 : ico ? 3 : px >= 32 ? 1 + px / 10_000 : 2.5 - px / 1000;
    found.push({ url: url.href, rank });
  }
  return found.sort((a, b) => a.rank - b.rank).map((f) => f.url);
}

/** An icon inlined in the page as a data: URL. */
function fromDataUrl(url: string): { buffer: Buffer; type: string } | null {
  const match = /^data:([^,;]*)((?:;[^,;]*)*),(.*)$/s.exec(url);
  if (!match || url.length > MAX_BYTES * 2) return null;
  const base64 = /;base64/i.test(match[2] ?? '');
  try {
    const buffer = base64 ? Buffer.from(match[3] ?? '', 'base64') : Buffer.from(decodeURIComponent(match[3] ?? ''), 'utf8');
    return buffer.length > 0 && buffer.length <= MAX_BYTES ? { buffer, type: match[1] ?? '' } : null;
  } catch {
    return null;
  }
}

async function iconFrom(url: string): Promise<string | null> {
  if (url.startsWith('data:')) {
    const inline = fromDataUrl(url);
    return inline ? iconDataUrl(inline.buffer, inline.type) : null;
  }
  const file = await get(url, 'image/*', MAX_BYTES);
  return file ? iconDataUrl(file.buffer, file.type) : null;
}

async function fetchIcon(host: string): Promise<string | null> {
  const attempts: Array<() => Promise<string | null>> = [
    () => iconFrom(`https://${host}/favicon.ico`),
    async () => {
      const page = await get(`https://${host}/`, 'text/html', PAGE_BYTES, true);
      for (const href of page ? declaredIcons(page.buffer.toString('utf8'), page.url).slice(0, 4) : []) {
        const icon = await iconFrom(href).catch(() => null);
        if (icon) return icon;
      }
      return null;
    },
    () => iconFrom(`https://${host}/apple-touch-icon.png`)
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
