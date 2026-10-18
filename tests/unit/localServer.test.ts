import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contextSize, OpenAiChatProvider } from '../../src/main/providers/openaiChat';
import { flavorOf, serverOrigin } from '../../src/main/providers/localServer';
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
