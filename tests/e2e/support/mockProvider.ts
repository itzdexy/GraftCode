import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A local OpenAI-compatible server for E2E tests (the "Custom endpoint"
 * provider). Chat turns are scripted; every request is recorded.
 */

export interface ScriptedToolCall {
  name: string;
  input: unknown;
}

export interface ScriptedTurn {
  /** Assistant text, streamed in small chunks. */
  text?: string;
  toolCalls?: ScriptedToolCall[];
  /** Delay between streamed chunks. */
  chunkDelayMs?: number;
  /** Keep the stream open after the text until the client disconnects (for interrupt tests). */
  hold?: boolean;
}

export interface RecordedRequest {
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
}

export const MOCK_MODELS = ['graft-test-large', 'graft-test-mini'] as const;
/** Model ids containing a small-tier word are used for titles; they get a fixed reply. */
const TITLE_MODEL = 'graft-test-mini';

function chunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({ id: 'chatcmpl-e2e', object: 'chat.completion.chunk', created: 0, model: 'mock', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

function splitText(text: string): string[] {
  return text.match(/.{1,12}/gs) ?? [];
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class MockProvider {
  readonly requests: RecordedRequest[] = [];
  private readonly turns: ScriptedTurn[] = [];
  private readonly apiKey: string | null;
  private server: http.Server | null = null;
  private port = 0;
  /** Resolves whenever a held stream is closed by the client. */
  private heldClosed: Array<() => void> = [];

  private constructor(apiKey: string | null) {
    this.apiKey = apiKey;
  }

  static async start(options: { apiKey?: string } = {}): Promise<MockProvider> {
    const mock = new MockProvider(options.apiKey ?? null);
    await mock.listen();
    return mock;
  }

  /** Base URL to paste into the "Custom endpoint" form. */
  get url(): string {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  /** Queues assistant turns; each chat request (except title requests) consumes one. */
  script(...turns: ScriptedTurn[]): void {
    this.turns.push(...turns);
  }

  get pendingTurns(): number {
    return this.turns.length;
  }

  /** Chat requests made with the main (non-title) model. */
  chatRequests(): RecordedRequest[] {
    return this.requests.filter((r) => r.path.endsWith('/chat/completions') && (r.body as { model?: string }).model !== TITLE_MODEL);
  }

  waitForHeldStreamClosed(): Promise<void> {
    return new Promise((resolve) => this.heldClosed.push(resolve));
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = null;
  }

  private listen(): Promise<void> {
    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    return new Promise((resolve) => {
      this.server?.listen(0, '127.0.0.1', () => {
        this.port = (this.server?.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  private async readBody(req: http.IncomingMessage): Promise<unknown> {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(part as Buffer);
    const text = Buffer.concat(parts).toString('utf8');
    return text.length > 0 ? (JSON.parse(text) as unknown) : null;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const body = req.method === 'POST' ? await this.readBody(req) : null;
    const authorization = req.headers.authorization ?? null;
    this.requests.push({ method: req.method ?? 'GET', path, authorization, body });

    if (this.apiKey && authorization !== `Bearer ${this.apiKey}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Incorrect API key provided.', type: 'invalid_request_error', code: 'invalid_api_key' } }));
      return;
    }
    if (req.method === 'GET' && path === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: MOCK_MODELS.map((id, i) => ({ id, object: 'model', created: 1_780_000_000 - i, owned_by: 'e2e' })) }));
      return;
    }
    if (req.method === 'POST' && path === '/v1/chat/completions') {
      const model = (body as { model?: string } | null)?.model;
      const turn: ScriptedTurn = model === TITLE_MODEL ? { text: 'Scripted title' } : (this.turns.shift() ?? { text: 'Done.' });
      await this.stream(res, turn);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `No route for ${req.method ?? ''} ${path}` } }));
  }

  private async stream(res: http.ServerResponse, turn: ScriptedTurn): Promise<void> {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    let closed = false;
    res.on('close', () => {
      closed = true;
    });
    const delay = turn.chunkDelayMs ?? 5;
    res.write(chunk({ role: 'assistant', content: '' }));
    for (const piece of splitText(turn.text ?? '')) {
      if (closed) return;
      res.write(chunk({ content: piece }));
      await sleep(delay);
    }
    if (turn.hold) {
      await new Promise<void>((resolve) => {
        if (closed) resolve();
        else res.on('close', () => resolve());
      });
      for (const notify of this.heldClosed.splice(0)) notify();
      return;
    }
    (turn.toolCalls ?? []).forEach((call, index) => {
      res.write(
        chunk({
          tool_calls: [{ index, id: `call_${index}_${Date.now()}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } }]
        })
      );
    });
    res.write(chunk({}, (turn.toolCalls ?? []).length > 0 ? 'tool_calls' : 'stop'));
    res.write(`data: ${JSON.stringify({ id: 'chatcmpl-e2e', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 120, completion_tokens: 30 } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }
}
