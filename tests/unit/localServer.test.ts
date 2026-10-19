import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contextSize, OpenAiChatProvider } from '../../src/main/providers/openaiChat';
import { detectLocalServers, firstByteTimeout, flavorOf, newServers, serverOrigin, type Candidate } from '../../src/main/providers/localServer';
import { json, startFixtureServer, type FixtureServer } from '../support/httpFixture';

describe('a server on this computer', () => {
  let server: FixtureServer;

  beforeEach(async () => {
    server = await startFixtureServer();
  });

  afterEach(async () => {
    await server.close();
  });

  function provider(customModels: Array<{ id: string; contextWindow?: number }> = []): OpenAiChatProvider {
    return new OpenAiChatProvider({ id: 'local', kind: 'openai-compatible', preset: null, apiKey: null, baseUrl: `${server.url}/v1` }, customModels);
  }

  it('finds the server behind an OpenAI-style base URL, and what kind of server it is', () => {
    expect(serverOrigin('http://127.0.0.1:8080/v1')).toBe('http://127.0.0.1:8080');
    expect(serverOrigin('http://127.0.0.1:1234/v1/')).toBe('http://127.0.0.1:1234');
    expect(serverOrigin('http://127.0.0.1:1234')).toBe('http://127.0.0.1:1234');
    expect(flavorOf([{ owned_by: 'llamacpp' }])).toBe('llamacpp');
    expect(flavorOf([{ meta: { n_ctx_train: 40960 } }])).toBe('llamacpp');
    expect(flavorOf([{ owned_by: 'organization_owner' }])).toBe('lmstudio');
    expect(flavorOf([{ owned_by: 'openai' }])).toBeNull();
    expect(flavorOf([])).toBeNull();
  });

  it('waits fifteen minutes for a local server and keeps hosted limits', () => {
    expect(firstByteTimeout('http://127.0.0.1:1234/v1', 120_000)).toBe(900_000);
    expect(firstByteTimeout('https://api.groq.com/openai/v1', 120_000)).toBe(120_000);
  });

  it("reads llama.cpp's loaded n_ctx, not n_ctx_train", async () => {
    server.route('GET', '/v1/models', (_req, res) =>
      json(res, 200, { data: [{ id: 'qwen3-coder', owned_by: 'llamacpp', meta: { n_ctx_train: 262144 } }] })
    );
    server.route('GET', '/props', (_req, res) => json(res, 200, { default_generation_settings: { n_ctx: 16384 } }));
    const [model] = await provider().listModels();
    expect(model?.contextWindow).toBe(16384);
  });

  it("reads LM Studio's loaded context length", async () => {
    server.route('GET', '/v1/models', (_req, res) => json(res, 200, { data: [{ id: 'qwen/qwen3-coder-30b', owned_by: 'organization_owner' }] }));
    server.route('GET', '/api/v0/models', (_req, res) =>
      json(res, 200, { data: [{ id: 'qwen/qwen3-coder-30b', state: 'loaded', loaded_context_length: 24576, max_context_length: 262144 }] })
    );
    const [model] = await provider().listModels();
    expect(model?.contextWindow).toBe(24576);
  });

  it('makes no probe for a server that is neither', async () => {
    server.route('GET', '/v1/models', (_req, res) => json(res, 200, { data: [{ id: 'gpt-local', owned_by: 'openai' }] }));
    await provider().listModels();
    expect(server.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /v1/models']);
  });

  it('keeps the listed size when a probe fails', async () => {
    server.route('GET', '/v1/models', (_req, res) =>
      json(res, 200, { data: [{ id: 'qwen3-coder', owned_by: 'llamacpp', meta: { n_ctx_train: 262144 } }] })
    );
    server.route('GET', '/props', (_req, res) => json(res, 500, { error: { message: 'busy' } }));
    const [model] = await provider().listModels();
    // The trained length is what the model could hold, not what this server loaded, so it is not taken as the size.
    expect(model?.contextWindow).toBe(contextSize({ reported: null, listed: null, typical: null, local: true }).tokens);
  });

  it('never assumes more than the model was trained for when the probe fails', async () => {
    server.route('GET', '/v1/models', (_req, res) => json(res, 200, { data: [{ id: 'tiny', owned_by: 'llamacpp', meta: { n_ctx_train: 4096 } }] }));
    server.route('GET', '/props', (_req, res) => json(res, 500, { error: { message: 'busy' } }));
    const [model] = await provider().listModels();
    expect(model?.contextWindow).toBe(4096);
  });

  it('lets a context size set in Settings win over the probe', async () => {
    server.route('GET', '/v1/models', (_req, res) =>
      json(res, 200, { data: [{ id: 'qwen3-coder', owned_by: 'llamacpp', meta: { n_ctx_train: 262144 } }] })
    );
    server.route('GET', '/props', (_req, res) => json(res, 200, { default_generation_settings: { n_ctx: 16384 } }));
    const [model] = await provider([{ id: 'qwen3-coder', contextWindow: 8192 }]).listModels();
    expect(model?.contextWindow).toBe(8192);
  });

  it('never takes more than the model was trained for', async () => {
    server.route('GET', '/v1/models', (_req, res) => json(res, 200, { data: [{ id: 'small', owned_by: 'llamacpp', meta: { n_ctx_train: 8192 } }] }));
    server.route('GET', '/props', (_req, res) => json(res, 200, { default_generation_settings: { n_ctx: 32768 } }));
    const [model] = await provider().listModels();
    expect(model?.contextWindow).toBe(8192);
  });
});

describe('finding the servers on this computer', () => {
  let server: FixtureServer;

  beforeEach(async () => {
    server = await startFixtureServer();
  });

  afterEach(async () => {
    await server.close();
  });

  const port = (): number => Number(new URL(server.url).port);
  const host = (): string => new URL(server.url).hostname;

  /** A port nothing listens on: one the system just handed out and took back. */
  async function closedPort(): Promise<number> {
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port: free } = probe.address() as net.AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return free;
  }

  function candidate(overrides: Partial<Candidate>): Candidate {
    return { name: 'vLLM', port: port(), kind: 'openai-compatible', preset: null, path: 'v1/models', ...overrides };
  }

  it('finds a server that answers and skips one that does not', async () => {
    server.route('GET', '/v1/models', (_req, res) => json(res, 200, { data: [{ id: 'a' }, { id: 'b' }] }));
    const found = await detectLocalServers({
      host: host(),
      timeoutMs: 1_000,
      candidates: [
        candidate({}),
        candidate({ name: 'Jan', port: await closedPort() }),
        // The port answers, but not with a model list on this path.
        candidate({ name: 'Ollama', kind: 'ollama', preset: 'ollama', path: 'api/tags' })
      ]
    });
    expect(found).toEqual([{ name: 'vLLM', kind: 'openai-compatible', preset: null, baseUrl: `${server.url}/v1`, models: 2 }]);

    server.route('GET', '/api/tags', (_req, res) => json(res, 200, { models: [{ name: 'qwen3:8b' }] }));
    const ollama = await detectLocalServers({ host: host(), candidates: [candidate({ name: 'Ollama', kind: 'ollama', preset: 'ollama', path: 'api/tags' })] });
    expect(ollama).toEqual([{ name: 'Ollama', kind: 'ollama', preset: 'ollama', baseUrl: server.url, models: 1 }]);
  });

  it('names a llama.cpp server only when its own endpoint says it is one', async () => {
    server.route('GET', '/v1/models', (_req, res) => json(res, 200, { data: [{ id: 'qwen3-coder' }] }));
    const llama = candidate({ name: 'llama.cpp' });
    expect((await detectLocalServers({ host: host(), candidates: [llama] }))[0]?.name).toBe('OpenAI-compatible server');
    server.route('GET', '/props', (_req, res) => json(res, 200, { default_generation_settings: { n_ctx: 8192 } }));
    expect((await detectLocalServers({ host: host(), candidates: [llama] }))[0]?.name).toBe('llama.cpp');
  });

  // Headers come, the body never ends: the search gives up on the server at its deadline. Closing the fixture in
  // afterEach drops these open connections.
  it.each([200, 404])('gives up on a server whose %i answer never finishes', async (status) => {
    server.route('GET', '/v1/models', (_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.write('{"data":[');
    });
    const started = Date.now();
    const found = await detectLocalServers({ host: host(), candidates: [candidate({})], timeoutMs: 300 });
    expect(found).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('skips a server already added', () => {
    const found = [
      { name: 'Ollama', kind: 'ollama' as const, preset: 'ollama', baseUrl: 'http://127.0.0.1:11434', models: 3 },
      { name: 'LM Studio', kind: 'openai-compatible' as const, preset: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1', models: 1 },
      { name: 'vLLM', kind: 'openai-compatible' as const, preset: null, baseUrl: 'http://127.0.0.1:8000/v1', models: 1 }
    ];
    const providers = [
      { kind: 'ollama' as const, baseUrl: 'http://LOCALHOST:11434/' },
      { kind: 'openai-compatible' as const, baseUrl: 'http://[::1]:1234/v1' },
      { kind: 'openai-compatible' as const, baseUrl: 'http://127.0.0.1:8000' },
      { kind: 'openai-compatible' as const, baseUrl: null }
    ];
    // The server on 8000 was added without /v1: that is another address, so it is still offered.
    expect(newServers(found, providers).map((s) => s.name)).toEqual(['vLLM']);
    expect(newServers(found, [{ kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:8000/v1/' }]).map((s) => s.name)).toEqual(['Ollama', 'LM Studio']);
  });

  it('counts a provider with no URL as one at its default address', () => {
    const found = [{ name: 'Ollama', kind: 'ollama' as const, preset: 'ollama', baseUrl: 'http://127.0.0.1:11434', models: 3 }];
    expect(newServers(found, [{ kind: 'ollama', baseUrl: null }])).toEqual([]);
  });
});
