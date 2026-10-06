import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ComfyClient, fillWorkflow, sizeFor, textToImageGraph } from '../../src/main/media/comfy';
import { extractImage, generateImage, DEFAULT_IMAGE_MODEL } from '../../src/main/media/images';
import { MediaService, type MediaSettings, type ProviderImageAccess } from '../../src/main/media/mediaService';
import { comfyTool, generateImageTool } from '../../src/main/tools/media';
import { decide } from '../../src/main/permissions/engine';
import { json, startFixtureServer, type FixtureServer } from '../support/httpFixture';
import { makeHarness } from '../support/sessionHarness';
import { makeTempDir, removeDir } from '../support/tmp';
import { makeToolContext } from '../support/toolContext';

/** A 1x1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const B64 = PNG.toString('base64');

let server: FixtureServer;
let dir: string;
beforeEach(async () => {
  server = await startFixtureServer();
  dir = makeTempDir();
});
afterEach(async () => {
  await server.close();
  removeDir(dir);
});

const SETTINGS: MediaSettings = { imageEngine: 'auto', imageModel: '', comfyEnabled: false, comfyUrl: 'http://127.0.0.1:8188', comfyCheckpoint: '' };

function service(settings: Partial<MediaSettings>, providers: ProviderImageAccess[] = []): MediaService {
  return new MediaService({ settings: () => ({ ...SETTINGS, ...settings }), providers: () => providers, graftHome: path.join(dir, 'home'), thumbnail: () => ({ mediaType: 'image/jpeg', data: 'thumb' }) });
}

describe('image models', () => {
  it('asks OpenRouter for an image with the model, prompt and shape, and reads the picture and its cost', async () => {
    server.route('POST', '/images', (_req, res) => json(res, 200, { data: [{ b64_json: B64, media_type: 'image/png' }], usage: { cost: 0.04 } }));
    const made = await generateImage({ kind: 'openrouter', apiKey: 'sk-or-test', baseUrl: server.url }, { prompt: 'a clay pot with a sprout', model: 'google/gemini-3.1-flash-image', aspect: 'wide', transparent: false });
    expect(made.data.equals(PNG)).toBe(true);
    expect(made).toMatchObject({ mediaType: 'image/png', costUsd: 0.04 });
    const sent = server.requests[0]!;
    expect(sent.headers.authorization).toBe('Bearer sk-or-test');
    expect(sent.json()).toMatchObject({ model: 'google/gemini-3.1-flash-image', prompt: 'a clay pot with a sprout', aspect_ratio: '16:9' });
  });

  it('tries again without the shape when a model refuses it', async () => {
    let calls = 0;
    server.route('POST', '/images', (req, res) => {
      calls++;
      if ((req.json() as { aspect_ratio?: string }).aspect_ratio) return json(res, 400, { error: { message: 'aspect_ratio is not supported by this model' } });
      return json(res, 200, { data: [{ b64_json: B64, media_type: 'image/png' }] });
    });
    const made = await generateImage({ kind: 'openrouter', apiKey: 'k', baseUrl: server.url }, { prompt: 'x', model: 'm', aspect: 'tall', transparent: false });
    expect(calls).toBe(2);
    expect(made.costUsd).toBeNull();
  });

  it('asks OpenAI with a size for the shape and a transparent background when wanted', async () => {
    server.route('POST', '/images/generations', (_req, res) => json(res, 200, { data: [{ b64_json: B64 }], output_format: 'png' }));
    const made = await generateImage({ kind: 'openai', apiKey: 'sk-test', baseUrl: server.url }, { prompt: 'an icon of a leaf', model: 'gpt-image-2', aspect: 'portrait', transparent: true });
    expect(made).toMatchObject({ mediaType: 'image/png' });
    expect(server.requests[0]!.json()).toMatchObject({ model: 'gpt-image-2', size: '1024x1536', background: 'transparent', output_format: 'png', n: 1 });
  });

  it('asks Gemini through its interactions endpoint with the key in a header', async () => {
    server.route('POST', '/interactions', (_req, res) => json(res, 200, { id: 'i1', output_image: { data: B64, mime_type: 'image/png' } }));
    const made = await generateImage({ kind: 'gemini', apiKey: 'AIza-test', baseUrl: server.url }, { prompt: 'a greenhouse', model: 'gemini-3.1-flash-image', aspect: 'landscape', transparent: false });
    expect(made.data.equals(PNG)).toBe(true);
    const sent = server.requests[0]!;
    expect(sent.headers['x-goog-api-key']).toBe('AIza-test');
    expect(sent.json()).toMatchObject({ model: 'gemini-3.1-flash-image', input: [{ type: 'text', text: 'a greenhouse' }], response_format: { type: 'image', aspect_ratio: '3:2' } });
  });

  it('finds the picture wherever a provider puts it in its answer', () => {
    expect(extractImage({ output_image: { data: B64, mime_type: 'image/png' } })).toEqual({ data: B64, mediaType: 'image/png' });
    expect(extractImage({ outputs: [{ type: 'text', text: 'here' }, { type: 'image', data: B64, mime_type: 'image/webp' }] })).toEqual({ data: B64, mediaType: 'image/webp' });
    expect(extractImage({ candidates: [{ content: { parts: [{ text: 'ok' }, { inlineData: { mimeType: 'image/jpeg', data: B64 } }] } }] })).toEqual({ data: B64, mediaType: 'image/jpeg' });
    expect(extractImage({ outputs: [{ type: 'text', text: 'no picture' }] })).toBeNull();
  });

  it('says so when a provider answers without a picture', async () => {
    server.route('POST', '/interactions', (_req, res) => json(res, 200, { output_text: 'I cannot draw that.' }));
    await expect(generateImage({ kind: 'gemini', apiKey: 'k', baseUrl: server.url }, { prompt: 'x', model: 'm', aspect: 'square', transparent: false })).rejects.toThrow(/no image/i);
  });

  it('has a default model for every provider that can make images', () => {
    expect(Object.keys(DEFAULT_IMAGE_MODEL).sort()).toEqual(['gemini', 'openai', 'openrouter']);
  });
});

/** A stand-in ComfyUI: two checkpoints, a video node, and a queue that finishes on the second look. */
function fakeComfy(options: { fail?: boolean } = {}): { graphs: unknown[] } {
  const graphs: unknown[] = [];
  let looks = 0;
  server.route('GET', '/system_stats', (_req, res) => json(res, 200, { system: { comfyui_version: '0.9.2' }, devices: [{ name: 'cuda:0 NVIDIA RTX 4070', vram_total: 12_884_901_888 }] }));
  server.route('GET', '/models/checkpoints', (_req, res) => json(res, 200, ['dreamshaperXL_v21.safetensors', 'sd15-base.safetensors']));
  server.route('GET', /^\/models\//, (_req, res) => json(res, 200, []));
  server.route('GET', '/object_info', (_req, res) => json(res, 200, { KSampler: {}, CheckpointLoaderSimple: {}, WanImageToVideo: {}, SaveImage: {} }));
  server.route('GET', '/object_info/KSampler', (_req, res) => json(res, 200, { KSampler: { input: { required: { steps: ['INT', { default: 20 }] } }, output: ['LATENT'] } }));
  server.route('POST', '/prompt', (req, res) => {
    if (options.fail) return json(res, 400, { error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation' }, node_errors: { '4': { errors: [{ message: 'Value not in list', details: "ckpt_name: 'missing.safetensors' not in list" }] } } });
    graphs.push((req.json() as { prompt: unknown }).prompt);
    return json(res, 200, { prompt_id: 'p1', number: 1, node_errors: {} });
  });
  server.route('GET', '/history/p1', (_req, res) => {
    looks++;
    if (looks < 2) return json(res, 200, {});
    return json(res, 200, { p1: { status: { status_str: 'success', completed: true }, outputs: { '9': { images: [{ filename: 'graft_00001_.png', subfolder: '', type: 'output' }] }, '12': { gifs: [{ filename: 'clip_00001.mp4', subfolder: 'video', type: 'output' }] } } } });
  });
  server.route('GET', '/view', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(PNG);
  });
  return { graphs };
}

describe('ComfyUI', () => {
  it('reports what is set up: version, graphics card, models and whether video nodes are installed', async () => {
    fakeComfy();
    const status = await new ComfyClient(server.url).status();
    expect(status.version).toBe('0.9.2');
    expect(status.devices[0]?.name).toContain('RTX 4070');
    expect(status.models.checkpoints).toEqual(['dreamshaperXL_v21.safetensors', 'sd15-base.safetensors']);
    expect(status.videoNodes).toEqual(['WanImageToVideo']);
  });

  it('queues a workflow, waits for it and brings back every file it made', async () => {
    const { graphs } = fakeComfy();
    const progress: string[] = [];
    const outputs = await new ComfyClient(server.url).run(textToImageGraph({ prompt: 'a sprout', checkpoint: 'sd15-base.safetensors', width: 512, height: 512, steps: 20, cfg: 7, seed: 5 }), { pollMs: 5, onProgress: (t) => progress.push(t) });
    expect(outputs.map((o) => [o.name, o.kind])).toEqual([
      ['graft_00001_.png', 'image'],
      ['clip_00001.mp4', 'video']
    ]);
    expect(outputs[0]?.data.equals(PNG)).toBe(true);
    expect(JSON.stringify(graphs[0])).toContain('a sprout');
    expect(progress.length).toBeGreaterThan(0);
  });

  it('explains which node refused a workflow', async () => {
    fakeComfy({ fail: true });
    await expect(new ComfyClient(server.url).run({ '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'missing.safetensors' } } }, { pollMs: 5 })).rejects.toThrow(/node 4.*missing\.safetensors/s);
  });

  it('says ComfyUI is not running when nothing answers', async () => {
    const url = server.url;
    await server.close();
    await expect(new ComfyClient(url).status()).rejects.toThrow(/ComfyUI/);
    server = await startFixtureServer();
  });

  it('picks a size and steps that suit the checkpoint', () => {
    expect(sizeFor('dreamshaperXL_v21.safetensors', 'wide')).toMatchObject({ width: 1344, height: 768 });
    expect(sizeFor('sd15-base.safetensors', 'square')).toMatchObject({ width: 512, height: 512, steps: 25 });
    expect(sizeFor('sdxl-lightning-4step.safetensors', 'square').steps).toBeLessThanOrEqual(8);
  });

  it('puts the prompt into a saved workflow, by placeholder or into the positive prompt, and applies overrides', () => {
    const graph = {
      '3': { class_type: 'KSampler', inputs: { seed: 1, positive: ['6', 0], negative: ['7', 0] } },
      '6': { class_type: 'CLIPTextEncode', inputs: { text: 'old prompt' } },
      '7': { class_type: 'CLIPTextEncode', inputs: { text: 'blurry' } }
    };
    const filled = fillWorkflow(graph, 'a red fox', { '3.seed': 42 }) as typeof graph;
    expect(filled['6'].inputs.text).toBe('a red fox');
    expect(filled['7'].inputs.text).toBe('blurry');
    expect(filled['3'].inputs.seed).toBe(42);
    expect(graph['6'].inputs.text).toBe('old prompt');
    const marked = fillWorkflow({ '1': { class_type: 'X', inputs: { text: 'photo of {{prompt}}, 35mm' } } }, 'a red fox', {}) as { '1': { inputs: { text: string } } };
    expect(marked['1'].inputs.text).toBe('photo of a red fox, 35mm');
    expect(() => fillWorkflow(graph, null, { '99.seed': 1 })).toThrow(/99/);
  });
});

describe('which engine makes images', () => {
  const openrouter: ProviderImageAccess = { kind: 'openrouter', apiKey: 'k', baseUrl: null };
  const openai: ProviderImageAccess = { kind: 'openai', apiKey: 'k', baseUrl: null };

  it('has none until a provider that makes images or ComfyUI is set up', () => {
    expect(service({}).imageEngine()).toBeNull();
    expect(service({ imageEngine: 'off' }, [openrouter]).imageEngine()).toBeNull();
  });

  it('uses the first provider that can make images, with its default model', () => {
    expect(service({}, [openai, openrouter]).imageEngine()).toEqual({ engine: 'openai', model: DEFAULT_IMAGE_MODEL.openai });
  });

  it('prefers ComfyUI when it is switched on, since it runs on this computer', () => {
    expect(service({ comfyEnabled: true }, [openrouter]).imageEngine()).toMatchObject({ engine: 'comfyui' });
  });

  it('uses the engine and model picked in Settings', () => {
    expect(service({ imageEngine: 'openrouter', imageModel: 'black-forest-labs/flux.2-pro' }, [openai, openrouter]).imageEngine()).toEqual({ engine: 'openrouter', model: 'black-forest-labs/flux.2-pro' });
    expect(service({ imageEngine: 'gemini' }, [openrouter]).imageEngine()).toBeNull();
  });

  it('lists saved ComfyUI workflows from the user folder and the project, the project winning', () => {
    const user = path.join(dir, 'home', 'comfyui');
    const project = path.join(dir, 'project', '.graft', 'comfyui');
    fs.mkdirSync(user, { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(user, 'portrait.json'), '{}');
    fs.writeFileSync(path.join(user, 'video.json'), '{}');
    fs.writeFileSync(path.join(project, 'video.json'), '{}');
    fs.writeFileSync(path.join(project, 'notes.txt'), 'x');
    const found = service({}).workflows(path.join(dir, 'project'));
    expect(found.map((w) => [w.name, w.source])).toEqual([
      ['portrait', 'user'],
      ['video', 'project']
    ]);
  });
});

describe('the GenerateImage tool', () => {
  const media = (cost: number | null = 0.04) => ({
    imageEngine: () => ({ engine: 'openrouter' as const, model: 'google/gemini-3.1-flash-image' }),
    generate: () => Promise.resolve({ data: PNG, mediaType: 'image/png', engine: 'openrouter' as const, model: 'google/gemini-3.1-flash-image', costUsd: cost }),
    thumbnail: () => ({ mediaType: 'image/jpeg' as const, data: 'thumb' }),
    comfy: () => null,
    workflows: () => []
  });

  it('saves the picture in the project, shows it and reports what it cost', async () => {
    const spent: number[] = [];
    const ctx = makeToolContext(dir, { media: media(), spend: (usd) => spent.push(usd) });
    const result = await generateImageTool.execute({ prompt: 'a hero image of a greenhouse', path: 'assets/hero.png' }, ctx);
    expect(result.isError).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'assets', 'hero.png')).equals(PNG)).toBe(true);
    expect(result.display).toMatchObject({ kind: 'media', engine: 'openrouter', costUsd: 0.04, files: [{ path: 'assets/hero.png', kind: 'image', thumb: 'thumb' }] });
    expect(result.content.some((c) => c.type === 'image')).toBe(true);
    expect(spent).toEqual([0.04]);
  });

  it('names the file after the format the model actually returned', async () => {
    const ctx = makeToolContext(dir, { media: { ...media(), generate: () => Promise.resolve({ data: PNG, mediaType: 'image/webp', engine: 'openrouter' as const, model: 'm', costUsd: null }) } });
    const result = await generateImageTool.execute({ prompt: 'x', path: 'art/cover.png' }, ctx);
    expect(result.display).toMatchObject({ files: [{ path: 'art/cover.webp' }] });
    expect(fs.existsSync(path.join(dir, 'art', 'cover.webp'))).toBe(true);
  });

  it('never replaces a file unless told to, and never writes outside the project or into .git', async () => {
    const ctx = makeToolContext(dir, { media: media() });
    fs.writeFileSync(path.join(dir, 'logo.png'), 'mine');
    expect((await generateImageTool.execute({ prompt: 'x', path: 'logo.png' }, ctx)).isError).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'logo.png'), 'utf8')).toBe('mine');
    expect((await generateImageTool.execute({ prompt: 'x', path: 'logo.png', overwrite: true }, ctx)).isError).toBe(false);
    expect((await generateImageTool.execute({ prompt: 'x', path: '../outside.png' }, ctx)).isError).toBe(true);
    expect((await generateImageTool.execute({ prompt: 'x', path: '.git/hooks/x.png' }, ctx)).isError).toBe(true);
  });

  it('keeps pictures a chat makes with the chat, for the user to save', async () => {
    const saved: string[] = [];
    const ctx = makeToolContext(dir, { media: media(), chatFiles: { save: (name) => (saved.push(name), { name, size: PNG.length, mime: 'image/png', path: path.join(dir, name) }) } });
    const result = await generateImageTool.execute({ prompt: 'a logo', path: 'logo.png' }, ctx);
    expect(saved).toEqual(['logo.png']);
    expect(result.display).toMatchObject({ kind: 'media', files: [{ path: 'logo.png' }] });
    expect(fs.existsSync(path.join(dir, 'logo.png'))).toBe(false);
  });

  it('explains how to set an engine up when there is none', async () => {
    const result = await generateImageTool.execute({ prompt: 'x', path: 'a.png' }, makeToolContext(dir));
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringMatching(/Settings/) as unknown });
  });

  it('is asked about in Ask mode, refused in Plan mode and remembered by its own name', async () => {
    const descriptor = await generateImageTool.describe({ prompt: 'x', path: 'assets/a.png' }, { cwd: dir, projectRoot: dir, platform: process.platform });
    const env = { projectRoot: dir, platform: process.platform, rules: { allow: [], ask: [], deny: [] } };
    const query = { toolName: 'GenerateImage', permissionClass: generateImageTool.permissionClass, descriptor };
    expect(decide(query, { ...env, mode: 'ask' })).toMatchObject({ behavior: 'ask', suggestedRule: 'GenerateImage' });
    expect(decide(query, { ...env, mode: 'plan' }).behavior).toBe('deny');
    expect(decide(query, { ...env, mode: 'ask', allowNetwork: true }).behavior).toBe('allow');
  });
});

describe('the ComfyUI tool', () => {
  const comfyMedia = () => {
    const svc = service({ comfyEnabled: true, comfyUrl: server.url });
    return svc;
  };

  it('reports what the user has set up before anything is generated', async () => {
    fakeComfy();
    const result = await comfyTool.execute({ action: 'status' }, makeToolContext(dir, { media: comfyMedia() }));
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    expect(result.isError).toBe(false);
    expect(text).toContain('dreamshaperXL_v21.safetensors');
    expect(text).toMatch(/video/i);
    expect(text).toContain('WanImageToVideo');
  });

  it('runs a saved workflow with the prompt filled in and saves what it made in the project', async () => {
    const { graphs } = fakeComfy();
    const workflows = path.join(dir, '.graft', 'comfyui');
    fs.mkdirSync(workflows, { recursive: true });
    fs.writeFileSync(path.join(workflows, 'clip.json'), JSON.stringify({ '6': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } } }));
    const result = await comfyTool.execute({ action: 'run', workflow: 'clip', prompt: 'a fox running', output_dir: 'media' }, makeToolContext(dir, { media: comfyMedia() }));
    expect(result.isError).toBe(false);
    expect(JSON.stringify(graphs[0])).toContain('a fox running');
    expect(fs.existsSync(path.join(dir, 'media', 'graft_00001_.png'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'media', 'clip_00001.mp4'))).toBe(true);
    expect(result.display).toMatchObject({ kind: 'media', engine: 'comfyui', files: [{ path: 'media/graft_00001_.png', kind: 'image' }, { path: 'media/clip_00001.mp4', kind: 'video' }] });
  });

  it('describes a node so a workflow can be written for what is installed', async () => {
    fakeComfy();
    const result = await comfyTool.execute({ action: 'node', name: 'KSampler' }, makeToolContext(dir, { media: comfyMedia() }));
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('steps') as unknown });
  });

  it('says ComfyUI is switched off when it is', async () => {
    const result = await comfyTool.execute({ action: 'status' }, makeToolContext(dir, { media: service({}) }));
    expect(result.isError).toBe(true);
  });
});

describe('image generation in a session', () => {
  const media = {
    imageEngine: () => ({ engine: 'openrouter' as const, model: 'google/gemini-3.1-flash-image' }),
    generate: () => Promise.resolve({ data: PNG, mediaType: 'image/png', engine: 'openrouter' as const, model: 'google/gemini-3.1-flash-image', costUsd: 0.04 }),
    thumbnail: () => null,
    comfy: () => null,
    workflows: () => []
  };

  it('offers GenerateImage only when an image model is set up, and names it in the prompt', async () => {
    let offered: string[] = [];
    let system = '';
    const script = [
      (request: { tools: Array<{ name: string }>; system: string }) => {
        offered = request.tools.map((t) => t.name);
        system = request.system;
        return { text: 'ok' };
      }
    ];
    const without = makeHarness({ script });
    without.session.send('hi');
    await without.session.idle();
    expect(offered).not.toContain('GenerateImage');
    expect(system).not.toContain('GenerateImage');

    const withImages = makeHarness({ script, media });
    withImages.session.send('hi');
    await withImages.session.idle();
    expect(offered).toContain('GenerateImage');
    expect(offered).not.toContain('ComfyUI');
    expect(system).toContain('google/gemini-3.1-flash-image');
  });

  it('makes the picture the model asks for, saves it in the project and adds what it cost to the session', async () => {
    const h = makeHarness({
      mode: 'auto',
      media,
      script: [{ toolCalls: [{ name: 'GenerateImage', input: { prompt: 'a sprout in a clay pot', path: 'assets/hero.png' } }] }, { text: 'Made it.' }]
    });
    h.session.send('make a hero image for the site');
    await h.session.idle();
    expect(fs.readFileSync(path.join(h.projectDir, 'assets', 'hero.png')).equals(PNG)).toBe(true);
    expect(h.session.summary.usage.costUsd).toBeCloseTo(0.04);
  });

  it('never offers image generation to an incognito chat', async () => {
    let offered: string[] = ['unset'];
    const h = makeHarness({
      kind: 'chat',
      incognito: true,
      media,
      chatFiles: { save: (_id, name) => ({ name, size: 1, mime: 'image/png', path: name }) },
      script: [
        (request: { tools: Array<{ name: string }> }) => {
          offered = request.tools.map((t) => t.name);
          return { text: 'ok' };
        }
      ]
    });
    h.session.send('draw me a logo');
    await h.session.idle();
    expect(offered).not.toContain('GenerateImage');
  });
});
