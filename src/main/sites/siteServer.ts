import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

/** Ports tried in order for the sites server (the first free one is used). */
const PORTS = Array.from({ length: 30 }, (_, i) => 4870 + i);
const VERSION_PATH = '/__graft/version';
/** A site nobody has asked about for this long stops being watched. */
const WATCH_IDLE_MS = 60_000;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm'
};

/**
 * Reloads the page when the site's files change (added to HTML pages Graft
 * serves). It asks for the site's version once a second over a fresh request
 * rather than holding a stream open: a long-lived loopback stream didn't
 * deliver later messages on some machines, and a local request costs nothing.
 */
const RELOAD_SCRIPT = `<script>(()=>{let v=null;const t=async()=>{try{const r=await fetch('${VERSION_PATH}',{cache:'no-store'});const x=await r.text();if(v!==null&&x!==v){location.reload();return}v=x}catch(e){}setTimeout(t,1000)};t()})();</script>`;

/** Adds the live-reload script to a page, before </body> when it has one. */
export function withReload(html: string): string {
  const at = html.toLowerCase().lastIndexOf('</body>');
  return at === -1 ? `${html}${RELOAD_SCRIPT}` : `${html.slice(0, at)}${RELOAD_SCRIPT}${html.slice(at)}`;
}

/**
 * The site a request is for, from its Host header ("peach-palace.localhost:4870").
 * Anything else is refused: a page on another domain that points its name at
 * 127.0.0.1 (DNS rebinding) must not be able to read local sites.
 */
export function siteFromHost(host: string | undefined, port: number): string | null {
  const m = /^([a-z0-9-]+)\.localhost(?::(\d+))?$/i.exec(host ?? '');
  if (!m || Number(m[2] ?? 80) !== port) return null;
  return m[1]!.toLowerCase();
}

/**
 * The file a URL path names inside a site folder: never outside it, never a
 * hidden file or folder (.graft-site, .git, .env), directories serve their
 * index.html, and "/about" finds about.html.
 */
export function resolveSitePath(folder: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0]!.split('#')[0]!);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const parts = decoded.split('/').filter((p) => p.length > 0);
  if (parts.some((p) => p.startsWith('.') || p.includes('\\'))) return null;
  const target = path.resolve(folder, ...parts);
  const rel = path.relative(folder, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const candidates = [target, path.join(target, 'index.html'), ...(path.extname(target) === '' ? [`${target}.html`] : [])];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Not this one; try the next.
    }
  }
  return null;
}

const NOT_FOUND = '<!doctype html><meta charset="utf-8"><title>Not found</title><body style="font:15px system-ui;margin:40px;color:#444"><h1 style="font-size:20px">Not found</h1><p>This site has no page here yet.</p></body>';

interface Watch {
  watcher: fs.FSWatcher;
  /** Changes since the site was first watched; pages reload when it moves. */
  version: number;
  lastAsked: number;
}

/**
 * Serves every site at http://<slug>.localhost:<port>/ from 127.0.0.1 only,
 * with live reload: open pages reload by themselves when the site's files change.
 */
export class SiteServer {
  private server: http.Server | null = null;
  private readonly watches = new Map<string, Watch>();
  private sweep: NodeJS.Timeout | null = null;
  port = 0;

  constructor(
    private readonly root: string,
    private readonly log: (level: 'info' | 'warn', message: string, fields?: Record<string, string>) => void,
    /** The page a site shows before it has an index.html; null when there is no such site. */
    private readonly starter: (slug: string) => string | null = () => null
  ) {}

  /** Starts the server on the first free port; a no-op when it already runs. */
  async start(): Promise<number> {
    if (this.server) return this.port;
    for (const port of PORTS) {
      const server = http.createServer((req, res) => this.handle(req, res));
      const ok = await new Promise<boolean>((resolve) => {
        server.once('error', () => resolve(false));
        server.listen(port, '127.0.0.1', () => resolve(true));
      });
      if (ok) {
        this.server = server;
        this.port = port;
        this.log('info', 'Sites server started', { port: String(port) });
        return port;
      }
      server.close();
    }
    throw new Error('No free port for the sites server (tried 4870-4899).');
  }

  url(slug: string): string {
    return `http://${slug}.localhost:${this.port}/`;
  }

  /**
   * Every answer closes its connection: reusing a
   * loopback connection stalled the next request on some Windows machines, and
   * a fresh local connection costs nothing.
   */
  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const slug = siteFromHost(req.headers.host, this.port);
    if (!slug) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' }).end('Forbidden');
      return;
    }
    const folder = path.join(this.root, slug);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }
    const urlPath = req.url ?? '/';
    if (urlPath.split('?')[0] === VERSION_PATH) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', connection: 'close' }).end(this.version(slug, folder));
      return;
    }
    const file = fs.existsSync(folder) ? resolveSitePath(folder, urlPath) : null;
    const starter = !file && (urlPath.split('?')[0] === '/' || urlPath === '') ? this.starter(slug) : null;
    if (starter) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', connection: 'close' }).end(req.method === 'HEAD' ? undefined : withReload(starter));
      return;
    }
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', connection: 'close' }).end(req.method === 'HEAD' ? undefined : withReload(NOT_FOUND));
      return;
    }
    const type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    const headers = { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', connection: 'close' };
    // Whole files rather than streams: site files are small, and piping a file stream into
    // the response stalled on some Node builds.
    fs.readFile(file, (error, data) => {
      if (error) {
        res.writeHead(500).end();
        return;
      }
      const body = type.startsWith('text/html') ? Buffer.from(withReload(data.toString('utf8'))) : data;
      res.writeHead(200, { ...headers, 'content-length': String(body.length) }).end(req.method === 'HEAD' ? undefined : body);
    });
  }

  /** The site's version for an open page, watching its folder from the first time anyone asks. */
  private version(slug: string, folder: string): string {
    let watch = this.watches.get(slug);
    if (!watch) {
      try {
        const created: Watch = {
          watcher: fs.watch(folder, { recursive: true }, (_event, name) => {
            // Graft's own bookkeeping (the gallery picture) isn't a change to the site.
            if (typeof name === 'string' && name.split(/[\\/]/)[0] === '.graft-site') return;
            created.version++;
          }),
          version: 0,
          lastAsked: Date.now()
        };
        created.watcher.on('error', (error) => {
          this.log('warn', 'Site watcher stopped', { site: slug, message: error.message });
          this.forget(slug);
        });
        watch = created;
        this.watches.set(slug, watch);
        this.sweep ??= setInterval(() => this.sweepIdle(), WATCH_IDLE_MS / 2);
        this.sweep.unref();
      } catch (error) {
        this.log('warn', 'Could not watch a site for changes', { site: slug, message: (error as Error).message });
        return 'unwatched';
      }
    }
    watch.lastAsked = Date.now();
    return String(watch.version);
  }

  /** Stops watching sites no open page has asked about for a while. */
  private sweepIdle(): void {
    const now = Date.now();
    for (const [slug, watch] of this.watches) if (now - watch.lastAsked > WATCH_IDLE_MS) this.forget(slug);
    if (this.watches.size === 0 && this.sweep) {
      clearInterval(this.sweep);
      this.sweep = null;
    }
  }

  /** Stops watching a site (it is about to be deleted). */
  forget(slug: string): void {
    const watch = this.watches.get(slug);
    if (!watch) return;
    watch.watcher.close();
    this.watches.delete(slug);
  }

  async close(): Promise<void> {
    for (const slug of [...this.watches.keys()]) this.forget(slug);
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = null;
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
