import { nativeImage } from 'electron';

/**
 * Site icons for web-search results. Hosts come from untrusted results, so
 * only public-looking names are fetched, over https, small and briefly; the
 * image is decoded and re-encoded as a 32px PNG data URL, so nothing from the
 * site reaches the renderer as-is. Results (including misses) are cached.
 */
const MAX_BYTES = 200 * 1024;
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

async function download(url: string): Promise<Buffer | null> {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: 'image/*', 'user-agent': 'Graft/1.0 (+desktop coding agent)' }
  });
  if (!response.ok || !response.url.startsWith('https://')) return null;
  const type = response.headers.get('content-type') ?? '';
  if (type && !/^image\//i.test(type) && !/octet-stream/i.test(type)) return null;
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > MAX_BYTES) return null;
  const buffer = Buffer.from(await response.arrayBuffer());
  return buffer.length > 0 && buffer.length <= MAX_BYTES ? buffer : null;
}

async function fetchIcon(host: string): Promise<string | null> {
  for (const path of ['/favicon.ico', '/apple-touch-icon.png']) {
    try {
      const buffer = await download(`https://${host}${path}`);
      if (!buffer) continue;
      const image = nativeImage.createFromBuffer(buffer);
      if (image.isEmpty()) continue;
      return image.resize({ width: 32, height: 32, quality: 'best' }).toDataURL();
    } catch {
      // Unreachable host, timeout or an image the platform can't decode: try the next path.
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
