import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ToolResultContent } from '@shared/schemas/messages';
import type { MediaFile, MediaKind } from '@shared/schemas/toolDisplay';
import { mimeOf } from '../chat/chatFiles';
import { fillWorkflow } from '../media/comfy';
import { IMAGE_ASPECTS } from '../media/images';
import { readWorkflow } from '../media/mediaService';
import { isAbortError } from '../providers/errors';
import { displayPath, isInsideReal, resolvePath } from './paths';
import { errorResult, type ToolContext, type ToolDefinition, type ToolResult } from './types';

/**
 * Generated media: GenerateImage makes one picture with the image model from
 * Settings → Images; ComfyUI works with the user's own ComfyUI (what is
 * installed, saved workflows, running one). Both save into the project in
 * code sessions and into the chat's files in chats, and never anywhere else.
 */

const EXTENSION: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' };

function size(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Why a path can't be written by a media tool, or null when it can: inside the project, and not Graft's or git's own folders. */
function pathProblem(target: string, ctx: Pick<ToolContext, 'projectRoot' | 'platform'>): string | null {
  if (!isInsideReal(ctx.projectRoot, target, ctx.platform)) return 'Generated files are saved inside the project folder. Give a path relative to the project, such as assets/hero.png.';
  const first = path.relative(ctx.projectRoot, target).split(path.sep)[0]?.toLowerCase();
  if (first === '.git' || first === '.graft') return `Generated files can't be saved in ${first}. Pick a folder such as assets or public.`;
  return null;
}

/** A path that names no existing file: the one given, or the same name with -2, -3… before the extension. */
function freePath(target: string): string {
  if (!fs.existsSync(target)) return target;
  const ext = path.extname(target);
  const stem = target.slice(0, target.length - ext.length);
  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem}-${String(n)}${ext}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  return `${stem}-${String(Date.now())}${ext}`;
}

function withExtension(file: string, ext: string): string {
  const current = path.extname(file);
  return `${current.length > 0 ? file.slice(0, -current.length) : file}.${ext}`;
}

function costText(costUsd: number | null): string {
  if (costUsd === null) return '';
  return costUsd === 0 ? ', made on this computer' : `, cost about $${costUsd.toFixed(costUsd < 0.1 ? 3 : 2)}`;
}

/** The picture itself for models that can see, so they can judge what they made. */
function preview(ctx: ToolContext, thumb: { mediaType: 'image/jpeg'; data: string } | null): ToolResultContent[] {
  return thumb && ctx.modelSupportsVision ? [{ type: 'image', mediaType: thumb.mediaType, data: thumb.data }] : [];
}

export const GenerateImageInput = z.object({
  prompt: z
    .string()
    .min(1)
    .max(4000)
    .describe('What the picture shows: subject, style, composition, colours and lighting. Say "no text" unless words belong in the picture.'),
  path: z.string().min(1).max(400).describe('Where to save it, relative to the project, e.g. "assets/hero.png". In a chat, a file name.'),
  aspect: z.enum(IMAGE_ASPECTS).optional().describe('square (default), landscape (3:2), portrait (2:3), wide (16:9) or tall (9:16).'),
  transparent: z.boolean().optional().describe('A transparent background, for logos, icons and cut-outs.'),
  overwrite: z.boolean().optional().describe('Replace the file if it already exists.')
});
export type GenerateImageInput = z.infer<typeof GenerateImageInput>;

export const generateImageTool: ToolDefinition<GenerateImageInput> = {
  name: 'GenerateImage',
  description: [
    'Make one picture with an image model and save it as a file: a hero image, an illustration, a photo-like scene, a texture, a logo.',
    'Use it when the user asks for generated or AI-made images. Each picture costs money on their key, so make the ones the work needs, not variations.',
    'For simple icons and shapes, write an SVG yourself instead.'
  ].join(' '),
  input: GenerateImageInput,
  // Network: it calls a provider with the user's key. The file it writes is declared, so Plan mode and the project boundary apply.
  permissionClass: 'network',
  concurrencySafe: () => true,
  timeoutMs: 20 * 60_000,
  describe(input, ctx) {
    return Promise.resolve({
      summary: `Generate ${path.basename(input.path)}`,
      writes: [resolvePath(input.path, ctx.cwd)],
      preview: { kind: 'generic', text: `Generate an image and save it as ${input.path}\n\n${input.prompt}` }
    });
  },
  async execute(input, ctx): Promise<ToolResult> {
    const media = ctx.media;
    const engine = media?.imageEngine() ?? null;
    if (!media || !engine) {
      return errorResult('No image model is set up. The user can add a provider that makes images (OpenRouter, OpenAI or Google) or turn on ComfyUI in Settings → Images.');
    }
    const target = ctx.chatFiles ? null : resolvePath(input.path, ctx.cwd);
    if (target) {
      const problem = pathProblem(target, ctx);
      if (problem) return errorResult(problem);
      if (fs.existsSync(target) && input.overwrite !== true) {
        return errorResult(`${input.path} already exists. Pick another name, or pass overwrite: true to replace it.`);
      }
    }
    let made;
    try {
      made = await media.generate({ prompt: input.prompt, aspect: input.aspect ?? 'square', transparent: input.transparent === true }, ctx.signal, (text) => ctx.progress(text));
    } catch (error) {
      if (ctx.signal.aborted || isAbortError(error)) throw error;
      return errorResult(`Couldn't generate the image: ${(error as Error).message}`);
    }
    const ext = EXTENSION[made.mediaType] ?? 'png';
    let shown: string;
    try {
      if (ctx.chatFiles) {
        shown = ctx.chatFiles.save(withExtension(path.basename(input.path), ext), made.data).name;
      } else {
        // The model decides the format; when that changes the name, an existing file is never replaced unasked.
        const wanted = withExtension(target!, ext);
        const final = wanted === target || input.overwrite === true ? wanted : freePath(wanted);
        fs.mkdirSync(path.dirname(final), { recursive: true });
        fs.writeFileSync(final, made.data);
        shown = displayPath(final, ctx.projectRoot, ctx.platform);
      }
    } catch (error) {
      return errorResult(`The image was generated but couldn't be saved: ${(error as Error).message}`);
    }
    if (made.costUsd !== null && made.costUsd > 0) ctx.spend(made.costUsd);
    const thumb = media.thumbnail(made.data);
    return {
      isError: false,
      content: [
        { type: 'text', text: `Saved ${shown} (${size(made.data.length)}, ${made.model || made.engine}${costText(made.costUsd)}). Give it meaningful alt text where it is used.` },
        ...preview(ctx, thumb)
      ],
      display: { kind: 'media', engine: made.engine, model: made.model, prompt: input.prompt, costUsd: made.costUsd, files: [{ path: shown, kind: 'image', bytes: made.data.length, thumb: thumb?.data ?? null }] }
    };
  }
};

export const ComfyInput = z.object({
  action: z
    .enum(['status', 'models', 'nodes', 'node', 'run'])
    .describe('status: what is installed and which workflows are saved. models: files in a model folder. nodes: node types by name. node: one node type’s inputs. run: run a workflow.'),
  folder: z.string().max(60).optional().describe('For models: the folder, e.g. checkpoints (default), diffusion_models, loras, vae.'),
  search: z.string().max(80).optional().describe('For nodes: part of a node type’s name, e.g. "video" or "KSampler".'),
  name: z.string().max(120).optional().describe('For node: the node type, e.g. KSampler.'),
  workflow: z.string().max(120).optional().describe('For run: the name of a saved workflow (see status).'),
  graph: z.record(z.string(), z.unknown()).optional().describe('For run: a workflow in ComfyUI’s API format, instead of a saved one: {"3": {"class_type": "KSampler", "inputs": {…}}, …}.'),
  prompt: z.string().max(4000).optional().describe('For run: the text prompt. It replaces {{prompt}} in the workflow, or the positive prompt when there is no marker.'),
  inputs: z.record(z.string(), z.unknown()).optional().describe('For run: values to set, named node.input, e.g. {"3.seed": 7, "5.width": 1024}.'),
  output_dir: z.string().max(300).optional().describe('For run: the project folder to save results in (default "comfyui-output").'),
  timeout_minutes: z.number().int().min(1).max(120).optional().describe('For run: how long to wait (default 15; video can need more).')
});
export type ComfyInput = z.infer<typeof ComfyInput>;

const NOT_ON = 'ComfyUI is switched off. The user can turn it on and set its address in Settings → Images.';

export const comfyTool: ToolDefinition<ComfyInput> = {
  name: 'ComfyUI',
  description: [
    'Work with the user’s own ComfyUI, which generates images and video on their computer.',
    'Start with status: it lists the installed models, whether video nodes are present and the saved workflows.',
    'Run a saved workflow by name, or write one in API format for what is installed (nodes and node tell you the inputs).',
    'Use it only when the user asks for images or video from ComfyUI or their local models.'
  ].join(' '),
  input: ComfyInput,
  permissionClass: 'network',
  concurrencySafe: (input) => input.action !== 'run',
  timeoutMs: 125 * 60_000,
  describe(input, ctx) {
    if (input.action !== 'run') {
      const what = { status: 'Checked ComfyUI', models: 'Listed ComfyUI models', nodes: 'Looked up ComfyUI nodes', node: `Read the ${input.name ?? ''} node` }[input.action];
      return Promise.resolve({ summary: what.trim() });
    }
    const label = input.workflow ? `the “${input.workflow}” workflow` : 'a workflow';
    return Promise.resolve({
      summary: `Run ${label} in ComfyUI`,
      writes: [resolvePath(input.output_dir ?? 'comfyui-output', ctx.cwd)],
      preview: { kind: 'generic', text: `Run ${label} in ComfyUI${input.prompt ? `\n\n${input.prompt}` : ''}` }
    });
  },
  async execute(input, ctx): Promise<ToolResult> {
    const media = ctx.media;
    const client = media?.comfy() ?? null;
    if (!media || !client) return errorResult(NOT_ON);
    const text = (value: string): ToolResult => ({ isError: false, content: [{ type: 'text', text: value }], display: { kind: 'text', text: value } });
    try {
      switch (input.action) {
        case 'status': {
          const status = await client.status(ctx.signal);
          const workflows = media.workflows(ctx.projectRoot);
          const models = Object.entries(status.models).map(([folder, files]) => `- ${folder} (${String(files.length)}): ${files.slice(0, 12).join(', ')}${files.length > 12 ? ', …' : ''}`);
          return text(
            [
              `ComfyUI ${status.version ?? ''} at ${status.url}`.replace('  ', ' '),
              status.devices.length > 0 ? `Devices: ${status.devices.map((d) => `${d.name}${d.vramTotal ? ` (${(d.vramTotal / 1024 ** 3).toFixed(0)} GB)` : ''}`).join('; ')}` : 'Devices: none reported',
              models.length > 0 ? `Models:\n${models.join('\n')}` : 'Models: none found in the standard folders.',
              status.videoNodes.length > 0 ? `Video: nodes for video are installed (${status.videoNodes.slice(0, 15).join(', ')}).` : 'Video: no video nodes found, so this setup makes images only.',
              workflows.length > 0
                ? `Saved workflows: ${workflows.map((w) => w.name).join(', ')}`
                : 'Saved workflows: none. API-format workflow files go in ~/.graft/comfyui or the project’s .graft/comfyui (in ComfyUI: Workflow → Export (API)).'
            ].join('\n')
          );
        }
        case 'models': {
          const folder = input.folder ?? 'checkpoints';
          const files = await client.models(folder, ctx.signal);
          return text(files.length > 0 ? `${folder}:\n${files.join('\n')}` : `No files in ${folder}.`);
        }
        case 'nodes': {
          const needle = (input.search ?? '').toLowerCase();
          const names = (await client.nodeNames(ctx.signal)).filter((n) => n.toLowerCase().includes(needle));
          return text(names.length > 0 ? `${String(names.length)} node types${needle ? ` matching “${input.search ?? ''}”` : ''}:\n${names.slice(0, 120).join('\n')}${names.length > 120 ? '\n…' : ''}` : 'No node type matches.');
        }
        case 'node': {
          if (!input.name) return errorResult('Name the node type, e.g. {"action": "node", "name": "KSampler"}.');
          const info = await client.node(input.name, ctx.signal);
          if (info === null) return errorResult(`ComfyUI has no node type called ${input.name}. Use nodes to search.`);
          const json = JSON.stringify(info, null, 1);
          return text(json.length > 8000 ? `${json.slice(0, 8000)}\n… (shortened)` : json);
        }
        case 'run':
          return await runWorkflow(input, ctx);
      }
    } catch (error) {
      if (ctx.signal.aborted || isAbortError(error)) throw error;
      return errorResult((error as Error).message);
    }
  }
};

async function runWorkflow(input: ComfyInput, ctx: ToolContext): Promise<ToolResult> {
  const media = ctx.media;
  const client = media?.comfy() ?? null;
  if (!media || !client) return errorResult(NOT_ON);
  let graph = input.graph ?? null;
  if (!graph) {
    if (!input.workflow) return errorResult('Give the name of a saved workflow, or a graph in API format.');
    const saved = media.workflows(ctx.projectRoot);
    const file = saved.find((w) => w.name.toLowerCase() === input.workflow?.toLowerCase());
    if (!file) return errorResult(`There is no saved workflow called ${input.workflow}. ${saved.length > 0 ? `Saved: ${saved.map((w) => w.name).join(', ')}.` : 'None are saved yet.'}`);
    graph = readWorkflow(file);
  }
  const dir = ctx.chatFiles ? null : resolvePath(input.output_dir ?? 'comfyui-output', ctx.cwd);
  if (dir) {
    const problem = pathProblem(dir, ctx);
    if (problem) return errorResult(problem);
  }
  const outputs = await client.run(fillWorkflow(graph, input.prompt ?? null, input.inputs ?? {}), {
    signal: ctx.signal,
    timeoutMs: (input.timeout_minutes ?? 15) * 60_000,
    onProgress: (text) => ctx.progress(text)
  });
  if (outputs.length === 0) return errorResult('The workflow finished without saving any file. It needs a node that saves its result (SaveImage, or a video save node).');
  const files: MediaFile[] = [];
  let firstThumb: { mediaType: 'image/jpeg'; data: string } | null = null;
  for (const output of outputs) {
    const thumb = output.kind === 'image' ? media.thumbnail(output.data) : null;
    firstThumb ??= thumb;
    let shown: string;
    if (ctx.chatFiles) {
      shown = ctx.chatFiles.save(output.name, output.data).name;
    } else {
      const final = freePath(path.join(dir!, output.name));
      fs.mkdirSync(path.dirname(final), { recursive: true });
      fs.writeFileSync(final, output.data);
      shown = displayPath(final, ctx.projectRoot, ctx.platform);
    }
    files.push({ path: shown, kind: output.kind, bytes: output.data.length, thumb: thumb?.data ?? null });
  }
  const kinds = (kind: MediaKind): number => files.filter((f) => f.kind === kind).length;
  const made = [kinds('image') > 0 ? `${String(kinds('image'))} image${kinds('image') === 1 ? '' : 's'}` : '', kinds('video') + kinds('gif') > 0 ? `${String(kinds('video') + kinds('gif'))} clip${kinds('video') + kinds('gif') === 1 ? '' : 's'}` : '']
    .filter(Boolean)
    .join(' and ');
  return {
    isError: false,
    content: [{ type: 'text', text: `ComfyUI made ${made || `${String(files.length)} files`}:\n${files.map((f) => `- ${f.path} (${mimeOf(f.path)}, ${size(f.bytes)})`).join('\n')}` }, ...preview(ctx, firstThumb)],
    display: { kind: 'media', engine: 'comfyui', model: input.workflow ?? 'workflow', prompt: input.prompt ?? '', costUsd: 0, files }
  };
}
