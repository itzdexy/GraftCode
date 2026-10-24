import { describe, expect, it } from 'vitest';
import { ModelOffering, type OfferInputs } from '../../src/main/agent/offering';
import type { MediaAccess } from '../../src/main/media/mediaService';
import { createBuiltinRegistry, LEAN_TOOLS } from '../../src/main/tools/builtin';
import { fakeModel } from '../support/fakeProvider';
import { testTool } from '../support/loopHarness';

function inputs(overrides: Partial<OfferInputs> = {}): OfferInputs {
  return {
    kind: 'code',
    incognito: false,
    webSearch: false,
    computerUse: false,
    searchEngine: null,
    registry: createBuiltinRegistry(),
    mcpToolNames: () => [],
    settingsRoot: '/project',
    hasBrowser: false,
    hasComputer: false,
    hasChatFiles: false,
    hasRunCode: false,
    hasBuiltinSkills: false,
    media: null,
    missionOpen: false,
    ...overrides
  };
}

function offering(overrides: Partial<OfferInputs> = {}): ModelOffering {
  return new ModelOffering(() => inputs(overrides));
}

/** A media setup of the test's own; the offering only reads `imageEngine` and `comfy`. */
function fakeMedia(overrides: Partial<MediaAccess> = {}): MediaAccess {
  return {
    imageEngine: () => null,
    generate: () => Promise.reject(new Error('No image generation in this test.')),
    thumbnail: () => null,
    comfy: () => null,
    workflows: () => [],
    videoModel: () => null,
    generateVideo: () => Promise.reject(new Error('No video in this test.')),
    ...overrides
  };
}

/** A registry with `count` MCP tools of one server, each heavy enough to weigh on a small window. */
function mcpRegistry(count: number, server = 'crm'): { names: string[]; registry: OfferInputs['registry'] } {
  const registry = createBuiltinRegistry();
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const name = `mcp__${server}__record_${String(i)}`;
    names.push(name);
    registry.upsert({
      ...testTool(name, { safe: true }),
      description: 'It works on the connected service. '.repeat(20),
      mcp: { server, tool: `record_${String(i)}`, readOnly: true, destructive: false }
    });
  }
  return { names, registry: { names: () => registry.names(), specs: (n, d) => registry.specs(n, d), get: (n) => registry.get(n) } };
}

describe('what a model is offered', () => {
  it('gives a code session the code tools and none of the chat-only or gated ones', () => {
    const tools = offering().tools(fakeModel());
    for (const expected of ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Shell', 'WebFetch', 'Task']) {
      expect(tools).toContain(expected);
    }
    for (const withheld of ['CreateFile', 'RunCode', 'Skill', 'WebSearch', 'ToolSearch', 'Computer', 'Browser', 'GenerateImage', 'ComfyUI', 'MissionUpdate']) {
      expect(tools).not.toContain(withheld);
    }
  });

  it('offers each gated code tool exactly when its condition holds', () => {
    const model = fakeModel();
    expect(offering({ webSearch: true, searchEngine: 'exa' }).tools(model)).toContain('WebSearch');
    // Anthropic's own search replaces WebSearch only on a model that has it.
    expect(offering({ webSearch: true, searchEngine: 'anthropic' }).tools(fakeModel({ supportsWebSearch: true }))).not.toContain('WebSearch');
    expect(offering({ webSearch: true, searchEngine: 'anthropic' }).tools(model)).toContain('WebSearch');
    expect(offering({ hasBrowser: true }).tools(model)).toContain('Browser');
    expect(offering({ hasComputer: true }).tools(model)).not.toContain('Computer');
    expect(offering({ hasComputer: true, computerUse: true }).tools(model)).toContain('Computer');
    expect(offering({ hasComputer: true, computerUse: true }).tools(fakeModel({ supportsVision: false }))).not.toContain('Computer');
    expect(offering({ missionOpen: true }).tools(model)).toContain('MissionUpdate');
  });

  it('reads web access from the session, the setting and the engine', () => {
    const model = fakeModel({ supportsWebSearch: true });
    expect(offering({ kind: 'chat' }).web(model)).toEqual({ native: false, clientSearch: false, fetch: false });
    expect(offering({ kind: 'chat', webSearch: true, searchEngine: 'anthropic' }).web(model)).toEqual({ native: true, clientSearch: false, fetch: true });
    expect(offering({ kind: 'chat', webSearch: true, searchEngine: 'exa' }).web(model)).toEqual({ native: false, clientSearch: true, fetch: true });
    // A code session always had WebFetch; an incognito chat still gets nothing.
    expect(offering().web(model)).toEqual({ native: false, clientSearch: false, fetch: true });
    expect(offering({ kind: 'chat', incognito: true, webSearch: true, searchEngine: 'exa' }).web(model)).toEqual({ native: false, clientSearch: false, fetch: false });
  });

  it('gives a chat its own tools, web access and what it may make', () => {
    const work = { hasChatFiles: true, hasRunCode: true, hasBuiltinSkills: true };
    const web = { webSearch: true, searchEngine: 'exa' as const };
    const tools = offering({ kind: 'chat', ...work, ...web }).tools(fakeModel());
    expect(tools).toEqual(['WebFetch', 'WebSearch', 'RunAgents', 'CreateFile', 'RunCode', 'Skill']);
    // A model's own search runs instead of WebSearch; the researchers still come with it.
    expect(offering({ kind: 'chat', ...work, ...web, searchEngine: 'anthropic' }).tools(fakeModel({ supportsWebSearch: true }))).toEqual(['WebFetch', 'RunAgents', 'CreateFile', 'RunCode', 'Skill']);
    // Skill never comes without CreateFile; files never without the chat file store.
    expect(offering({ kind: 'chat', hasRunCode: true, hasBuiltinSkills: true }).tools(fakeModel())).not.toContain('CreateFile');
    expect(offering({ kind: 'chat', hasBuiltinSkills: true }).tools(fakeModel())).not.toContain('Skill');
    expect(offering({ kind: 'chat', hasRunCode: true }).tools(fakeModel())).not.toContain('RunCode');
    // An incognito chat never goes out and never writes to disk.
    expect(offering({ kind: 'chat', incognito: true, ...work, ...web }).tools(fakeModel())).toEqual([]);
  });

  it('offers generated media as it is set up, and never in incognito', () => {
    const media = fakeMedia({ imageEngine: () => ({ engine: 'openai', model: 'gpt-image' }) });
    const comfy = fakeMedia({ imageEngine: () => ({ engine: 'comfyui', model: '' }), comfy: () => ({}) as unknown as NonNullable<ReturnType<MediaAccess['comfy']>> });
    expect(offering({ media }).media(fakeModel())).toEqual({ image: 'gpt-image', video: null, comfy: false });
    expect(offering({ media: comfy }).media(fakeModel())).toEqual({ image: 'ComfyUI on this computer', video: null, comfy: true });
    expect(offering({ media, incognito: true }).media(fakeModel())).toEqual({ image: null, video: null, comfy: false });
    // ComfyUI is a tool of code sessions; GenerateImage comes to a chat only with its files.
    expect(offering({ media: comfy }).tools(fakeModel())).toContain('ComfyUI');
    expect(offering({ kind: 'chat', media }).tools(fakeModel())).not.toContain('GenerateImage');
    expect(offering({ kind: 'chat', media, hasChatFiles: true }).tools(fakeModel())).toContain('GenerateImage');
    // Video comes with an OpenRouter key: GenerateVideo to code sessions, and to a chat that keeps files.
    const video = fakeMedia({ videoModel: () => 'google/veo-3.1-lite' });
    expect(offering({ media: video }).media(fakeModel()).video).toBe('google/veo-3.1-lite');
    expect(offering({ media: video }).tools(fakeModel())).toContain('GenerateVideo');
    expect(offering({ media }).tools(fakeModel())).not.toContain('GenerateVideo');
    expect(offering({ kind: 'chat', media: video, hasChatFiles: true }).tools(fakeModel())).toContain('GenerateVideo');
    expect(offering({ media: video, incognito: true }).media(fakeModel()).video).toBeNull();
  });

  it('keeps a big MCP setup waiting for ToolSearch, and offers what was loaded', () => {
    const { registry, names } = mcpRegistry(12);
    const model = fakeModel({ contextWindow: 20_000 });
    const subject = new ModelOffering(() => inputs({ registry, mcpToolNames: () => names }));
    const tools = subject.tools(model);
    expect(tools).toContain('ToolSearch');
    for (const name of names) expect(tools).not.toContain(name);
    expect(subject.deferring(model)).toBe(true);
    expect(subject.deferredByServer(model)).toEqual([{ server: 'crm', count: 12 }]);
    expect(subject.deferredEntries(model)).toHaveLength(12);

    subject.load([names[0]!]);
    expect(subject.tools(model)).toContain(names[0]);
    expect(subject.deferredByServer(model)).toEqual([{ server: 'crm', count: 11 }]);
    expect(subject.deferredEntries(model).map((t) => t.name)).not.toContain(names[0]);
  });

  it('sends a small MCP setup with every request', () => {
    const registry = createBuiltinRegistry();
    registry.upsert({ ...testTool('mcp__crm__lookup', { safe: true }), mcp: { server: 'crm', tool: 'lookup', readOnly: true, destructive: false } });
    const subject = new ModelOffering(() => inputs({ registry, mcpToolNames: () => ['mcp__crm__lookup'] }));
    expect(subject.tools(fakeModel({ contextWindow: 20_000 }))).toContain('mcp__crm__lookup');
    expect(subject.deferring(fakeModel({ contextWindow: 20_000 }))).toBe(false);
  });

  it('gives a code session its project’s MCP tools and a chat the user’s, both keyed by the project root', () => {
    const asked: Array<string | null> = [];
    const subject = offering({
      mcpToolNames: (root) => {
        asked.push(root);
        return [];
      }
    });
    subject.mcpTools(fakeModel());
    expect(asked).toEqual(['/project']);
    const chat = offering({
      kind: 'chat',
      mcpToolNames: (root) => {
        asked.push(root);
        return [];
      }
    });
    chat.mcpTools(fakeModel());
    expect(asked.at(-1)).toBeNull();
  });

  it('offers a lean code model the core tools and ToolSearch', () => {
    const model = fakeModel({ lean: true });
    const subject = offering({ hasBrowser: true });
    expect([...subject.tools(model)].sort()).toEqual([...LEAN_TOOLS, 'ToolSearch'].sort());
    expect(subject.deferring(model)).toBe(true);
    // The other built-ins wait under Graft's own name, so the prompt and ToolSearch can point at them.
    expect(subject.deferredEntries(model)).toContainEqual(expect.objectContaining({ name: 'Browser', server: 'graft' }));
    expect(subject.deferredEntries(model).map((t) => t.name)).not.toContain('Read');
    expect(subject.deferredByServer(model)).toEqual([{ server: 'graft', count: subject.deferredEntries(model).length }]);
    // A chat has no lean set: its tools are few already.
    expect(offering({ kind: 'chat', webSearch: true, searchEngine: 'exa' }).tools(model)).not.toContain('ToolSearch');
  });

  it('sends MissionUpdate to a lean model while a mission is open, without making it wait', () => {
    const model = fakeModel({ lean: true });
    const subject = offering({ missionOpen: true });
    expect(subject.tools(model)).toContain('MissionUpdate');
    expect(subject.deferredEntries(model).map((t) => t.name)).not.toContain('MissionUpdate');
    expect(offering().tools(model)).not.toContain('MissionUpdate');
  });

  it('tells a lean model that ToolSearch finds Graft’s own tools, and leaves a full model’s description alone', () => {
    expect(offering().toolDescriptions(fakeModel({ lean: true })).ToolSearch).toMatch(/Graft's own/);
    expect(offering().toolDescriptions(fakeModel())).toEqual({});
  });

  it('offers a tool ToolSearch loaded on a lean model', () => {
    const model = fakeModel({ lean: true });
    const subject = offering({ hasBrowser: true });
    subject.load(['Browser']);
    expect(subject.tools(model)).toContain('Browser');
    expect(subject.deferredEntries(model).map((t) => t.name)).not.toContain('Browser');
  });

  it('keeps every MCP tool of a lean model waiting, however small the setup', () => {
    const registry = createBuiltinRegistry();
    registry.upsert({ ...testTool('mcp__crm__lookup', { safe: true }), mcp: { server: 'crm', tool: 'lookup', readOnly: true, destructive: false } });
    const subject = new ModelOffering(() => inputs({ registry, mcpToolNames: () => ['mcp__crm__lookup'] }));
    const lean = fakeModel({ lean: true });
    expect(subject.tools(lean)).not.toContain('mcp__crm__lookup');
    expect(subject.deferredByServer(lean)).toEqual(expect.arrayContaining([{ server: 'crm', count: 1 }]));
    expect(subject.deferredEntries(lean)).toContainEqual(expect.objectContaining({ name: 'mcp__crm__lookup', server: 'crm' }));
    // The same small setup goes out whole to a full model.
    expect(subject.tools(fakeModel())).toContain('mcp__crm__lookup');
  });

  it('gives the full tool set again after a switch to a full model', () => {
    const subject = offering({ hasBrowser: true });
    expect(subject.tools(fakeModel({ lean: true }))).not.toContain('Symbols');
    const full = subject.tools(fakeModel());
    expect(full).toContain('Symbols');
    expect(full).toContain('Browser');
    expect(full).not.toContain('ToolSearch');
    expect(subject.deferring(fakeModel())).toBe(false);
  });

  it('describes RunAgents in a chat only', () => {
    expect(Object.keys(offering({ kind: 'chat' }).toolDescriptions(fakeModel()))).toEqual(['RunAgents']);
    expect(offering().toolDescriptions(fakeModel())).toEqual({});
  });
});
