import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

/** Ports tried in order for the sites server (the first free one is used). */
const PORTS = Array.from({ length: 30 }, (_, i) => 4870 + i);
const VERSION_PATH = '/__graft/version';
/** A site nobody has asked about for this long stops being watched. */
const WATCH_IDLE_MS = 60_000;
/** Where a site that is built keeps what its build made: the only part of it that is served. */
const BUILD_DIR = 'dist';
/** A build writes its files one after another; they count as one change once it has been quiet this long. */
const BUILD_SETTLE_MS = 250;

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
  /** For a site that is built: the wait for its build to have finished writing. */
  settle: NodeJS.Timeout | null;
  /** For a site that is built: its built page as it was when last looked at (see buildStamp). */
  stamp: string;
}

/**
 * A built site's page as it is on disk right now, in a form that is different after every build
 * that changed it. Under a burst of changes (an install) the system reports that something changed
 * without saying what; whether that was the build is then read off the page the build writes.
 */
function buildStamp(folder: string): string {
  try {
    const stat = fs.statSync(path.join(folder, BUILD_DIR, 'index.html'));
    return `${String(stat.mtimeMs)}:${String(stat.size)}`;
  } catch {
    return 'none';
  }
}

/**
 * Serves every site at http://<slug>.localhost:<port>/ from 127.0.0.1 only,
 * with live reload: open pages reload by themselves when the site's files change.
 * A plain site is its folder. A site that is built is its dist folder and nothing
 * else: its sources, packages and settings are not on show, an address that names
 * no file gets its page (an app of one page draws the right view itself), and
 * open pages reload when a build has finished, not when a source file changes.
 */
export class SiteServer {
  private server: http.Server | null = null;
  private readonly watches = new Map<string, Watch>();
  private sweep: NodeJS.Timeout | null = null;
  port = 0;

  constructor(
    private readonly root: string,
    private readonly log: (level: 'info' | 'warn', message: string, fields?: Record<string, string>) => void,
    /** The page a site shows before it has one of its own; null when there is no such site. */
    private readonly starter: (slug: string) => string | null = () => null,
    /** Whether a site is one that is built (see the class comment). */
    private readonly built: (slug: string) => boolean = () => false
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
    const built = this.built(slug);
    const shown = built ? path.join(folder, BUILD_DIR) : folder;
    const asked = urlPath.split('?')[0] ?? '/';
    let file = fs.existsSync(shown) ? resolveSitePath(shown, urlPath) : null;
    // No file by that name in a built site: its page answers, unless the address names a file (it has an ending) or something hidden.
    if (!file && built && path.extname(asked) === '' && !asked.split('/').some((part) => part.startsWith('.')) && fs.existsSync(shown)) file = resolveSitePath(shown, '/');
    const starter = !file && (asked === '/' || asked === '') ? this.starter(slug) : null;
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
        // Settled once for as long as the site is watched: an install writes thousands of files, and asking
        // for each of them would read the site's record from disk each time. What a site is built with never changes.
        const built = this.built(slug);
        const created: Watch = {
          watcher: fs.watch(folder, { recursive: true }, (_event, name) => {
            const top = typeof name === 'string' ? name.split(/[\\/]/)[0] : null;
            // Graft's own bookkeeping (the gallery picture) isn't a change to the site.
            if (top === '.graft-site') return;
            if (!built) {
              created.version++;
              return;
            }
            // A site that is built changes when its build does, not with its sources or its packages.
            if (top !== null && top !== BUILD_DIR) return;
            // A change with no name: only a build if the built page is no longer what it was.
            if (top === null && buildStamp(folder) === created.stamp) return;
            if (created.settle) clearTimeout(created.settle);
            created.settle = setTimeout(() => {
              created.settle = null;
              created.stamp = buildStamp(folder);
              created.version++;
            }, BUILD_SETTLE_MS);
            created.settle.unref();
          }),
          version: 0,
          lastAsked: Date.now(),
          settle: null,
          stamp: built ? buildStamp(folder) : ''
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
    if (watch.settle) clearTimeout(watch.settle);
    this.watches.delete(slug);
  }

  async close(): Promise<void> {
    for (const slug of [...this.watches.keys()]) this.forget(slug);
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = null;
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Chromium may leave a speculative or partially received request open.
      // This server only serves local previews; shutdown must also end those sockets.
      server.closeAllConnections();
    });
  }
}
