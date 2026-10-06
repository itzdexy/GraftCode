import { GraftError } from '@shared/errors';
import type { MediaKind } from '@shared/schemas/toolDisplay';
import { ProviderError } from '../providers/errors';
import { joinUrl, request, requestJson } from '../providers/http';
import type { ImageAspect } from './images';

/**
 * ComfyUI, the node-graph image and video generator people run on their own
 * computer. Graft talks to its HTTP API: it reads what is installed, queues
 * a workflow (a graph in ComfyUI's API format), waits for it and fetches the
 * files it made. Everything ComfyUI returns is data from another program:
 * file names are reduced to plain names before anything is written.
 */

export interface ComfyStatus {
  url: string;
  version: string | null;
  devices: Array<{ name: string; vramTotal: number | null }>;
  /** Model files by folder (checkpoints, diffusion_models, loras, vae…); folders that hold nothing are left out. */
  models: Record<string, string[]>;
  /** Node types that make video, when any are installed (they come with custom nodes or newer ComfyUI versions). */
  videoNodes: string[];
}

export interface ComfyOutput {
  name: string;
  kind: MediaKind;
  data: Buffer;
}

export type ComfyGraph = Record<string, unknown>;

const MODEL_FOLDERS = ['checkpoints', 'diffusion_models', 'unet', 'loras', 'vae', 'text_encoders', 'controlnet', 'upscale_models'];
const VIDEO_NODE = /video|animatediff|wan|ltxv|hunyuan|cogvideo|mochi|svd_|animatedwebp|webm/i;
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const MAX_OUTPUT_BYTES = 500 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Text from another program's JSON: strings and numbers as they are, anything else as the fallback. */
function text(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : fallback;
}

function kindOf(name: string): MediaKind {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (['png', 'jpg', 'jpeg', 'webp', 'bmp'].includes(ext)) return 'image';
  if (ext === 'gif') return 'gif';
  if (['mp4', 'webm', 'mov', 'mkv', 'avi'].includes(ext)) return 'video';
  if (['wav', 'mp3', 'flac', 'ogg'].includes(ext)) return 'audio';
  return 'file';
}

/** A plain file name: whatever ComfyUI calls a file, nothing of it can name a folder. */
function plainName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const base = (name.replace(/\\/g, '/').split('/').pop() ?? '').replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/^[. ]+/, '');
  return base.length > 0 ? base.slice(0, 160) : 'output';
}

const SLEEP = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new GraftError('interrupted', 'Interrupted by the user.'));
      },
      { once: true }
    );
  });

/** Width, height, steps and guidance that suit a checkpoint, judged by its name (SDXL-class models work at 1024, older ones at 512; distilled ones need few steps). */
export function sizeFor(checkpoint: string, aspect: ImageAspect): { width: number; height: number; steps: number; cfg: number } {
  const name = checkpoint.toLowerCase();
  const large = /xl|pony|illustrious|noobai|sd3|flux|playground/.test(name);
  const fast = /turbo|lightning|hyper|lcm|schnell|dmd/.test(name);
  const sizes: Record<ImageAspect, [number, number]> = large
    ? { square: [1024, 1024], landscape: [1216, 832], portrait: [832, 1216], wide: [1344, 768], tall: [768, 1344] }
    : { square: [512, 512], landscape: [768, 512], portrait: [512, 768], wide: [896, 512], tall: [512, 896] };
  const [width, height] = sizes[aspect];
  return { width, height, steps: fast ? 6 : 25, cfg: fast ? 2 : 7 };
}

/** The standard text-to-image graph for a checkpoint that carries its own text encoder and VAE. */
export function textToImageGraph(options: { prompt: string; negative?: string; checkpoint: string; width: number; height: number; steps: number; cfg: number; seed: number }): ComfyGraph {
  return {
    '3': {
      class_type: 'KSampler',
      inputs: { seed: options.seed, steps: options.steps, cfg: options.cfg, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] }
    },
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: options.checkpoint } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: options.width, height: options.height, batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: options.prompt, clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: options.negative ?? 'blurry, low quality, watermark, text', clip: ['4', 1] } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'graft', images: ['8', 0] } }
  };
}

/**
 * A copy of a saved workflow with the prompt and any overrides filled in.
 * The prompt replaces every `{{prompt}}` in the workflow's text inputs; a
 * workflow without that marker gets it as the text of the node its sampler's
 * `positive` input points at. Overrides are "node.input" → value.
 */
export function fillWorkflow(graph: ComfyGraph, prompt: string | null, overrides: Record<string, unknown>): ComfyGraph {
  const copy = structuredClone(graph);
  const inputsOf = (id: string): Record<string, unknown> | null => {
    const node = copy[id];
    return isRecord(node) && isRecord(node.inputs) ? node.inputs : null;
  };
  if (prompt !== null) {
    let marked = false;
    for (const id of Object.keys(copy)) {
      const inputs = inputsOf(id);
      if (!inputs) continue;
      for (const [key, value] of Object.entries(inputs)) {
        if (typeof value === 'string' && value.includes('{{prompt}}')) {
          inputs[key] = value.split('{{prompt}}').join(prompt);
          marked = true;
        }
      }
    }
    if (!marked) {
      for (const id of Object.keys(copy)) {
        const positive = inputsOf(id)?.positive;
        const target = Array.isArray(positive) && typeof positive[0] === 'string' ? inputsOf(positive[0]) : null;
        if (target && typeof target.text === 'string') {
          target.text = prompt;
          break;
        }
      }
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    const dot = key.indexOf('.');
    const inputs = dot > 0 ? inputsOf(key.slice(0, dot)) : null;
    if (!inputs) throw new GraftError('bad_workflow_input', `The workflow has no node "${dot > 0 ? key.slice(0, dot) : key}" to set "${key}" on. Inputs are named node.input, for example 3.seed.`);
    inputs[key.slice(dot + 1)] = value;
  }
  return copy;
}

/** "node 4: Value not in list (ckpt_name: 'x' not in list)" for each node ComfyUI refused. */
function nodeErrors(body: unknown): string {
  if (!isRecord(body) || !isRecord(body.node_errors)) return '';
  return Object.entries(body.node_errors)
    .flatMap(([id, node]) =>
      isRecord(node) && Array.isArray(node.errors)
        ? node.errors.filter(isRecord).map((e) => `node ${id}: ${text(e.message, 'invalid')}${text(e.details, '') ? ` (${text(e.details, '')})` : ''}`)
        : []
    )
    .slice(0, 8)
    .join('; ');
}

export class ComfyClient {
  constructor(readonly baseUrl: string) {}

  private async get<T>(path: string, signal?: AbortSignal, timeoutMs = 15_000): Promise<T> {
    try {
      return await requestJson<T>({ url: joinUrl(this.baseUrl, path), headers: { accept: 'application/json' }, ...(signal ? { signal } : {}), timeoutMs });
    } catch (error) {
      if (error instanceof ProviderError && error.code === 'network') {
        throw new GraftError('comfy_unreachable', `ComfyUI isn't answering at ${this.baseUrl}. Start ComfyUI, or change its address in Settings → Images.`);
      }
      throw error;
    }
  }

  async models(folder: string, signal?: AbortSignal): Promise<string[]> {
    const list = await this.get<unknown>(`models/${encodeURIComponent(folder)}`, signal).catch((error: unknown) => {
      // Older ComfyUI versions answer 404 for folders they don't know.
      if (error instanceof ProviderError && error.code === 'not_found') return [];
      throw error;
    });
    return Array.isArray(list) ? list.filter((n): n is string => typeof n === 'string') : [];
  }

  async nodeNames(signal?: AbortSignal): Promise<string[]> {
    const info = await this.get<unknown>('object_info', signal, 60_000);
    return isRecord(info) ? Object.keys(info).sort() : [];
  }

  /** One node type's inputs and outputs, as ComfyUI describes them; null when it isn't installed. */
  async node(name: string, signal?: AbortSignal): Promise<unknown> {
    const info = await this.get<unknown>(`object_info/${encodeURIComponent(name)}`, signal).catch((error: unknown) => {
      if (error instanceof ProviderError && error.code === 'not_found') return null;
      throw error;
    });
    return isRecord(info) ? (info[name] ?? null) : null;
  }

  async status(signal?: AbortSignal): Promise<ComfyStatus> {
    const stats = await this.get<{ system?: { comfyui_version?: unknown }; devices?: Array<{ name?: unknown; vram_total?: unknown }> }>('system_stats', signal);
    const [names, ...folders] = await Promise.all([this.nodeNames(signal), ...MODEL_FOLDERS.map((folder) => this.models(folder, signal))]);
    const models: Record<string, string[]> = {};
    MODEL_FOLDERS.forEach((folder, i) => {
      const files = folders[i] ?? [];
      if (files.length > 0) models[folder] = files;
    });
    return {
      url: this.baseUrl,
      version: typeof stats.system?.comfyui_version === 'string' ? stats.system.comfyui_version : null,
      devices: (stats.devices ?? []).map((d) => ({ name: text(d.name, 'device'), vramTotal: typeof d.vram_total === 'number' ? d.vram_total : null })),
      models,
      videoNodes: names.filter((n) => VIDEO_NODE.test(n)).slice(0, 40)
    };
  }

  /** Queues a workflow, waits for it to finish and returns the files it made. Stopping the turn takes it off ComfyUI's queue. */
  async run(graph: ComfyGraph, options: { signal?: AbortSignal; timeoutMs?: number; pollMs?: number; onProgress?: (text: string) => void } = {}): Promise<ComfyOutput[]> {
    const { signal } = options;
    // Sent with fetch itself: when ComfyUI refuses a workflow, the body says which node and input to fix.
    let response: Response;
    try {
      response = await fetch(joinUrl(this.baseUrl, 'prompt'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: graph, client_id: 'graft' }),
        ...(signal ? { signal } : {})
      });
    } catch {
      if (signal?.aborted) throw new GraftError('interrupted', 'Interrupted by the user.');
      throw new GraftError('comfy_unreachable', `ComfyUI isn't answering at ${this.baseUrl}. Start ComfyUI, or change its address in Settings → Images.`);
    }
    const queued: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const summary = isRecord(queued) && isRecord(queued.error) ? text(queued.error.message, '') : '';
      throw new GraftError('comfy_rejected', `ComfyUI refused the workflow: ${nodeErrors(queued) || summary || `HTTP ${String(response.status)}`}`);
    }
    const id = isRecord(queued) && typeof queued.prompt_id === 'string' ? queued.prompt_id : null;
    if (!id) throw new GraftError('comfy_rejected', 'ComfyUI did not queue the workflow.');
    options.onProgress?.('Queued in ComfyUI\n');
    const started = Date.now();
    let reported = started;
    const deadline = started + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const cancel = (): void => {
      // Best effort: take it off the queue, and stop it if it is the one running.
      void requestJson({ url: joinUrl(this.baseUrl, 'queue'), body: { delete: [id] }, timeoutMs: 5_000 }).catch(() => undefined);
      void requestJson({ url: joinUrl(this.baseUrl, 'interrupt'), body: {}, timeoutMs: 5_000 }).catch(() => undefined);
    };
    for (;;) {
      if (signal?.aborted) {
        cancel();
        throw new GraftError('interrupted', 'Interrupted by the user.');
      }
      if (Date.now() > deadline) {
        cancel();
        throw new GraftError('comfy_timeout', 'ComfyUI took too long and the workflow was stopped. Give it more time with timeout_minutes, or use a lighter workflow.');
      }
      const history = await this.get<unknown>(`history/${encodeURIComponent(id)}`, signal);
      const entry = isRecord(history) ? history[id] : undefined;
      if (isRecord(entry)) {
        const status = isRecord(entry.status) ? entry.status : {};
        if (status.status_str === 'error') throw new GraftError('comfy_failed', `The workflow failed in ComfyUI: ${failureText(status)}`);
        if (status.completed !== false) return this.collect(entry.outputs, signal);
      }
      await SLEEP(options.pollMs ?? 1_000, signal).catch((error: unknown) => {
        cancel();
        throw error;
      });
      if (Date.now() - reported >= 10_000) {
        reported = Date.now();
        options.onProgress?.(`Generating… ${String(Math.round((reported - started) / 1000))}s\n`);
      }
    }
  }

  private async collect(outputs: unknown, signal?: AbortSignal): Promise<ComfyOutput[]> {
    const refs: Array<{ filename: string; subfolder: string; type: string }> = [];
    if (isRecord(outputs)) {
      for (const node of Object.values(outputs)) {
        if (!isRecord(node)) continue;
        for (const list of Object.values(node)) {
          if (!Array.isArray(list)) continue;
          for (const item of list) {
            if (isRecord(item) && typeof item.filename === 'string' && item.type !== 'temp') {
              refs.push({ filename: item.filename, subfolder: typeof item.subfolder === 'string' ? item.subfolder : '', type: typeof item.type === 'string' ? item.type : 'output' });
            }
          }
        }
      }
    }
    const files: ComfyOutput[] = [];
    let total = 0;
    for (const ref of refs.slice(0, 32)) {
      const query = new URLSearchParams({ filename: ref.filename, subfolder: ref.subfolder, type: ref.type });
      const response = await request({ url: `${joinUrl(this.baseUrl, 'view')}?${query.toString()}`, ...(signal ? { signal } : {}), timeoutMs: 60_000 });
      const data = Buffer.from(await response.arrayBuffer());
      total += data.length;
      if (total > MAX_OUTPUT_BYTES) throw new GraftError('comfy_too_large', 'The workflow made more than 500 MB of files; the rest was left in ComfyUI’s output folder.');
      files.push({ name: plainName(ref.filename), kind: kindOf(ref.filename), data });
    }
    return files;
  }
}

function failureText(status: Record<string, unknown>): string {
  const messages = Array.isArray(status.messages) ? status.messages : [];
  for (const message of messages) {
    if (Array.isArray(message) && message[0] === 'execution_error' && isRecord(message[1])) {
      const m = message[1];
      return `${text(m.node_type, 'a node')} (node ${text(m.node_id, '?')}): ${text(m.exception_message, 'error').trim().slice(0, 600)}`;
    }
  }
  return 'ComfyUI reported an error without details. Its own window has the full log.';
}
