import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
  json(): unknown;
}

export type Handler = (req: RecordedRequest, res: ServerResponse) => void | Promise<void>;

export interface FixtureServer {
  url: string;
  requests: RecordedRequest[];
  route(method: string, path: string | RegExp, handler: Handler): void;
  close(): Promise<void>;
}

/** Minimal local HTTP server for replaying provider wire formats in tests. */
export async function startFixtureServer(): Promise<FixtureServer> {
  const routes: Array<{ method: string; path: string | RegExp; handler: Handler }> = [];
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const recorded: RecordedRequest = {
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        headers: req.headers,
        body,
        json: () => JSON.parse(body) as unknown
      };
      requests.push(recorded);
      const pathname = (req.url ?? '/').split('?')[0] ?? '/';
      const match = routes.find(
        (r) => r.method === recorded.method && (typeof r.path === 'string' ? r.path === pathname : r.path.test(pathname))
      );
      if (!match) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `no route for ${recorded.method} ${pathname}` } }));
        return;
      }
      Promise.resolve(match.handler(recorded, res)).catch((error: unknown) => {
        res.writeHead(500);
        res.end(String(error));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    route(method, path, handler) {
      routes.push({ method, path, handler });
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/**
 * Writes SSE events, split into awkward chunks (every `split` bytes) so
 * parsers are exercised across line and event boundaries.
 */
export async function sse(
  res: ServerResponse,
  events: Array<{ event?: string; data: unknown }>,
  split = 7
): Promise<void> {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const text = events
    .map((e) => `${e.event ? `event: ${e.event}\r\n` : ''}data: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}\r\n\r\n`)
    .join('');
  for (let i = 0; i < text.length; i += split) {
    res.write(text.slice(i, i + split));
    await new Promise((r) => setImmediate(r));
  }
  res.end();
}

export async function ndjson(res: ServerResponse, lines: unknown[]): Promise<void> {
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  for (const line of lines) {
    res.write(`${JSON.stringify(line)}\n`);
    await new Promise((r) => setImmediate(r));
  }
  res.end();
}
