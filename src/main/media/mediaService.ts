import fs from 'node:fs';
import path from 'node:path';
import { GraftError } from '@shared/errors';
import { ComfyClient, sizeFor, textToImageGraph, type ComfyGraph } from './comfy';
import { DEFAULT_IMAGE_MODEL, generateImage, type ImageAspect, type ImageProviderKind } from './images';
import { DEFAULT_VIDEO_MODEL, generateVideo, type MadeVideo, type VideoRequest } from './videos';

/**
 * Generated media for the agent's tools (Settings → Images): which engine
 * makes pictures, the connection to ComfyUI, and the saved ComfyUI workflows.
 * Provider keys come in through `providers`; they are never returned.
 */
export type ImageEngineId = ImageProviderKind | 'comfyui';

export interface MediaSettings {
  /** "auto": ComfyUI when it is on, else the first provider that makes images. */
  imageEngine: 'auto' | 'off' | ImageEngineId;
  /** A model id for the chosen provider; empty uses its default. */
  imageModel: string;
  comfyEnabled: boolean;
  comfyUrl: string;
  /** A checkpoint file for plain text-to-image; empty picks the first one installed. */
  comfyCheckpoint: string;
  /** An OpenRouter video model; empty uses the default. */
  videoModel: string;
}

export interface ProviderImageAccess {
  /** The provider's id in Settings → Providers. */
  id: string;
  kind: ImageProviderKind;
  apiKey: string;
  baseUrl: string | null;
}

export interface MediaDeps {
  settings(): MediaSettings;
  /** Providers with a key that can make images, the preferred one first. */
  providers(): ProviderImageAccess[];
  graftHome: string;
  /** A small JPEG of a picture, for the transcript; absent where images can't be resized (tests). */
  thumbnail?(data: Buffer): { mediaType: 'image/jpeg'; data: string } | null;
}

export interface WorkflowFile {
  name: string;
  path: string;
  source: 'user' | 'project';
}

export interface MadeImage {
  data: Buffer;
  mediaType: string;
  engine: ImageEngineId;
  model: string;
  costUsd: number | null;
}

/** What the media tools use; the service implements it, and tests stand in for it. */
export interface MediaAccess {
  imageEngine(): { engine: ImageEngineId; model: string } | null;
  generate(request: ImageGeneration, signal: AbortSignal, onProgress?: (text: string) => void): Promise<MadeImage>;
  thumbnail(data: Buffer): { mediaType: 'image/jpeg'; data: string } | null;
  comfy(): ComfyClient | null;
  workflows(projectRoot: string | null): WorkflowFile[];
  /** The video model GenerateVideo uses, or null without an OpenRouter key. */
  videoModel(): string | null;
  generateVideo(request: Omit<VideoRequest, 'model'> & { model?: string | null }, signal: AbortSignal, onProgress?: (text: string) => void): Promise<MadeVideo>;
}

export interface ImageGeneration {
  prompt: string;
  aspect: ImageAspect;
  transparent: boolean;
  /** An image model to use instead of Settings → Images', with the provider it is on (the session's model, when it is an image model). */
  model?: { id: string; providerId: string } | null;
}

const MAX_WORKFLOW_BYTES = 2_000_000;

function workflowsIn(dir: string, source: 'user' | 'project'): WorkflowFile[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return [];
    throw error;
  }
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.json'))
    .map((e) => ({ name: e.name.slice(0, -5), path: path.join(dir, e.name), source }));
}

/** A saved workflow in ComfyUI's API format: an object of nodes, each with a class_type. */
export function readWorkflow(file: WorkflowFile): ComfyGraph {
  if (fs.statSync(file.path).size > MAX_WORKFLOW_BYTES) throw new GraftError('bad_workflow', `${file.name} is too large to be a workflow.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file.path, 'utf8'));
  } catch {
    throw new GraftError('bad_workflow', `${file.name} isn't valid JSON.`);
  }
  const nodes = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? Object.values(parsed) : [];
  const apiFormat = nodes.length > 0 && nodes.every((n) => typeof n === 'object' && n !== null && 'class_type' in n);
  if (!apiFormat) {
    throw new GraftError('bad_workflow', `${file.name} isn't in ComfyUI's API format. In ComfyUI, use Workflow → Export (API) and save that file instead.`);
  }
  return parsed as ComfyGraph;
}

export class MediaService implements MediaAccess {
  constructor(private readonly deps: MediaDeps) {}

  comfy(): ComfyClient | null {
    const settings = this.deps.settings();
    return settings.comfyEnabled && settings.comfyUrl.trim().length > 0 ? new ComfyClient(settings.comfyUrl.trim().replace(/\/+$/, '')) : null;
  }

  imageEngine(): { engine: ImageEngineId; model: string } | null {
    const settings = this.deps.settings();
    if (settings.imageEngine === 'off') return null;
    const comfy = settings.comfyEnabled;
    if (settings.imageEngine === 'comfyui' || (settings.imageEngine === 'auto' && comfy)) {
      return comfy ? { engine: 'comfyui', model: settings.comfyCheckpoint } : null;
    }
    const providers = this.deps.providers();
    const provider = settings.imageEngine === 'auto' ? providers[0] : providers.find((p) => p.kind === settings.imageEngine);
    if (!provider) return null;
    // A model id belongs to the engine it was chosen for; "auto" always uses the provider's default.
    const model = settings.imageEngine !== 'auto' && settings.imageModel.trim().length > 0 ? settings.imageModel.trim() : DEFAULT_IMAGE_MODEL[provider.kind];
    return { engine: provider.kind, model };
  }

  async generate(request: ImageGeneration, signal: AbortSignal, onProgress?: (text: string) => void): Promise<MadeImage> {
    if (request.model) {
      const named = request.model;
      const access = this.deps.providers().find((p) => p.id === named.providerId);
      if (!access) throw new GraftError('no_image_engine', `Graft can't make pictures through that model's provider. Images work through OpenRouter, OpenAI, Google and NVIDIA.`);
      const made = await generateImage(access, { prompt: request.prompt, model: named.id, aspect: request.aspect, transparent: request.transparent }, signal);
      return { ...made, engine: access.kind, model: named.id };
    }
    const chosen = this.imageEngine();
    if (!chosen) throw new GraftError('no_image_engine', 'No image model is set up. Add a provider that makes images (OpenRouter, OpenAI, Google or NVIDIA) or turn on ComfyUI in Settings → Images.');
    if (chosen.engine === 'comfyui') return this.generateWithComfy(request, chosen.model, signal, onProgress);
    const access = this.deps.providers().find((p) => p.kind === chosen.engine);
    if (!access) throw new GraftError('no_image_engine', 'The provider chosen for images has no key anymore. Check Settings → Providers.');
    const made = await generateImage(access, { prompt: request.prompt, model: chosen.model, aspect: request.aspect, transparent: request.transparent }, signal);
    return { ...made, engine: chosen.engine, model: chosen.model };
  }

  private async generateWithComfy(request: { prompt: string; aspect: ImageAspect }, wanted: string, signal: AbortSignal, onProgress?: (text: string) => void): Promise<MadeImage> {
    const client = this.comfy();
    if (!client) throw new GraftError('no_image_engine', 'ComfyUI is switched off in Settings → Images.');
    const checkpoints = await client.models('checkpoints', signal);
    const checkpoint = wanted.length > 0 && checkpoints.includes(wanted) ? wanted : checkpoints[0];
    if (!checkpoint) {
      throw new GraftError(
        'comfy_no_checkpoint',
        'ComfyUI has no checkpoint in its checkpoints folder, so plain text-to-image has nothing to run. Use the ComfyUI tool with a saved workflow instead, or add a checkpoint.'
      );
    }
    const size = sizeFor(checkpoint, request.aspect);
    const graph = textToImageGraph({ prompt: request.prompt, checkpoint, ...size, seed: Math.floor(Math.random() * 2 ** 31) });
    const outputs = await client.run(graph, { signal, ...(onProgress ? { onProgress } : {}) });
    const image = outputs.find((o) => o.kind === 'image');
    if (!image) throw new GraftError('comfy_failed', 'ComfyUI finished without making an image.');
    const ext = image.name.toLowerCase().split('.').pop() ?? 'png';
    return { data: image.data, mediaType: ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`, engine: 'comfyui', model: checkpoint, costUsd: 0 };
  }

  videoModel(): string | null {
    if (!this.deps.providers().some((p) => p.kind === 'openrouter')) return null;
    return this.deps.settings().videoModel.trim() || DEFAULT_VIDEO_MODEL;
  }

  /** One clip, made through OpenRouter's video API with the user's key. */
  async generateVideo(request: Omit<VideoRequest, 'model'> & { model?: string | null }, signal: AbortSignal, onProgress?: (text: string) => void): Promise<MadeVideo> {
    const model = request.model ?? this.videoModel();
    const access = this.deps.providers().find((p) => p.kind === 'openrouter');
    if (!model || !access) throw new GraftError('no_video_model', 'Making video needs OpenRouter as a provider with its key. Add it in Settings → Providers.');
    const { model: _named, ...rest } = request;
    return generateVideo({ apiKey: access.apiKey, baseUrl: access.baseUrl }, { ...rest, model }, signal, onProgress);
  }

  /** Providers with a key that can make images (for Settings). */
  providerKinds(): ImageProviderKind[] {
    return [...new Set(this.deps.providers().map((p) => p.kind))];
  }

  thumbnail(data: Buffer): { mediaType: 'image/jpeg'; data: string } | null {
    try {
      return this.deps.thumbnail?.(data) ?? null;
    } catch {
      return null;
    }
  }

  /** Saved workflows: ~/.graft/comfyui and <project>/.graft/comfyui; the project's replaces the user's of the same name. */
  workflows(projectRoot: string | null): WorkflowFile[] {
    const byName = new Map<string, WorkflowFile>();
    for (const w of workflowsIn(path.join(this.deps.graftHome, 'comfyui'), 'user')) byName.set(w.name, w);
    if (projectRoot) for (const w of workflowsIn(path.join(projectRoot, '.graft', 'comfyui'), 'project')) byName.set(w.name, w);
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}
