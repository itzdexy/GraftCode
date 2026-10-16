import type { ModelInfo } from '@shared/schemas/models';
import type { MediaAccess } from '../media/mediaService';
import { RUN_AGENTS_IN_CHAT } from '../tools/agentTools';
import { CHAT_ONLY_TOOLS } from '../tools/builtin';
import type { ToolRegistry } from '../tools/registry';
import type { SearchableTool } from '../tools/toolSearch';
import type { SearchEngineId } from '../tools/web/search';
import { estimateTextTokens } from './tokens';

/** MCP tool definitions weighing more than this (or a tenth of the model's window) wait to be loaded with ToolSearch. */
const DEFER_MCP_TOKENS = 10_000;

/** Web access a model is offered: a search its provider runs, a search Graft runs, and reading pages. */
export interface WebAccess {
  native: boolean;
  clientSearch: boolean;
  fetch: boolean;
}

/** What a chat may make for the user: files and documents, the code sandbox, and the skills it reads. */
export interface ChatWork {
  files: boolean;
  code: boolean;
  skills: boolean;
}

/** Generated media a model is offered: the image engine behind GenerateImage, and whether ComfyUI is connected. */
export interface MediaOffer {
  image: string | null;
  comfy: boolean;
}

/**
 * What the offering reads: the session's kind, the settings that decide what is offered,
 * and the services that are set up. A function so every read is of the live state.
 */
export interface OfferInputs {
  kind: 'code' | 'chat';
  /** An incognito chat never goes out, so it gets no web, media or MCP tools. */
  incognito: boolean;
  /** Settings → Web search. */
  webSearch: boolean;
  /** Settings → Permissions: code sessions may use the screen, mouse and keyboard. */
  computerUse: boolean;
  /** Where searches go (Settings → Web search); null when none is set up. */
  searchEngine: SearchEngineId | null;
  /** Built-in and MCP tools. */
  registry: Pick<ToolRegistry, 'names' | 'specs' | 'get'>;
  /** MCP tools visible in this project (a code session's) or to the user (a chat's). */
  mcpToolNames(projectRoot: string | null): string[];
  /** The project whose MCP servers a code session sees. */
  settingsRoot: string | null;
  hasBrowser: boolean;
  hasComputer: boolean;
  hasChatFiles: boolean;
  hasRunCode: boolean;
  hasBuiltinSkills: boolean;
  media: MediaAccess | null;
  /** Whether a mission is open (MissionUpdate is offered only then). */
  missionOpen: boolean;
}

/**
 * What a model is offered in a session: its tools, its web access, what it can make, and the
 * MCP tools a big setup keeps waiting until ToolSearch loads them. This is decided here and
 * nowhere else, so the session's turn loop only has to ask.
 */
export class ModelOffering {
  /** A setup too big to send with every request waits; once the decision is made it holds for the session. */
  private deferredAll = false;
  /** The MCP tools ToolSearch has loaded: the running turn offers them from its next request on. */
  private readonly loaded = new Set<string>();

  constructor(private readonly inputs: () => OfferInputs) {}

  /**
   * Web access for this session and model. The search engine setting decides
   * where searches go: the WebSearch tool runs them, except that a model's
   * built-in search (Claude on Anthropic, the only adapter with one) runs when
   * Anthropic is the engine. WebFetch reads pages. Incognito chats get none,
   * so nothing goes to a search engine.
   */
  web(model: ModelInfo): WebAccess {
    const inputs = this.inputs();
    const allowed = inputs.webSearch && !inputs.incognito && model.supportsTools;
    const engine = allowed ? inputs.searchEngine : null;
    const native = engine === 'anthropic' && model.supportsWebSearch;
    const clientSearch = engine !== null && !native;
    // Code sessions always had WebFetch (it asks first in Ask mode); chats get it with web access on.
    return { native, clientSearch, fetch: inputs.kind === 'code' || allowed };
  }

  /** CreateFile and RunCode, for chats with a model that uses tools. Incognito chats get neither: they never write to disk. */
  chatWork(model: ModelInfo): ChatWork {
    const inputs = this.inputs();
    const files = inputs.kind === 'chat' && !inputs.incognito && model.supportsTools && inputs.hasChatFiles;
    // A skill ends in a file the chat saves, so Skill comes with CreateFile and never without it.
    return { files, code: files && inputs.hasRunCode, skills: files && inputs.hasBuiltinSkills };
  }

  /**
   * Generated media for this session and model: the image engine behind
   * GenerateImage, and whether ComfyUI is connected. Incognito chats get
   * neither, so nothing they write goes to an image provider.
   */
  media(model: ModelInfo): MediaOffer {
    const inputs = this.inputs();
    const media = inputs.media;
    if (!media || !model.supportsTools || inputs.incognito) return { image: null, comfy: false };
    const engine = media.imageEngine();
    return { image: engine ? (engine.engine === 'comfyui' ? 'ComfyUI on this computer' : engine.model) : null, comfy: media.comfy() !== null };
  }

  /** Computer use: code sessions with it switched on, on a model that can see screenshots. */
  computer(model: ModelInfo): boolean {
    const inputs = this.inputs();
    return inputs.kind === 'code' && inputs.hasComputer && inputs.computerUse && model.supportsVision;
  }

  /** Tools a turn on this model offers: built-ins for the session kind, plus MCP tools in code sessions. */
  tools(model: ModelInfo): string[] {
    const inputs = this.inputs();
    const web = this.web(model);
    const work = this.chatWork(model);
    const computer = this.computer(model);
    const media = this.media(model);
    // Chats get the apps connected for all projects (never in incognito, which keeps everything local).
    const mcpTools = this.mcpTools(model);
    const chatOnly = new Set<string>(CHAT_ONLY_TOOLS);
    const onMission = inputs.kind === 'code' && inputs.missionOpen;
    const builtins =
      inputs.kind === 'code'
        ? inputs.registry
            .names()
            .filter(
              (n) =>
                !n.startsWith('mcp__') &&
                !chatOnly.has(n) &&
                (n !== 'WebSearch' || web.clientSearch) &&
                n !== 'ToolSearch' &&
                (n !== 'Computer' || computer) &&
                (n !== 'Browser' || inputs.hasBrowser) &&
                (n !== 'GenerateImage' || media.image !== null) &&
                (n !== 'ComfyUI' || media.comfy) &&
                (n !== 'MissionUpdate' || onMission)
            )
        : [
            ...(web.fetch ? ['WebFetch'] : []),
            ...(web.clientSearch ? ['WebSearch'] : []),
            // Researchers, for a question with several parts: they get the web tools above and nothing else.
            ...(web.fetch || web.clientSearch ? ['RunAgents'] : []),
            ...(work.files ? ['CreateFile'] : []),
            ...(work.code ? ['RunCode'] : []),
            ...(work.skills ? ['Skill'] : []),
            // A chat keeps what it makes in its own files, so pictures need those.
            ...(work.files && media.image !== null ? ['GenerateImage'] : [])
          ];
    const { offered } = this.splitMcp(mcpTools, model);
    return [...builtins, ...(this.deferredAll ? ['ToolSearch'] : []), ...offered];
  }

  /** What a tool is in this session, where its own description is about another kind: in a chat a group of agents only researches. */
  toolDescriptions(): Partial<Record<string, string>> {
    return this.inputs().kind === 'chat' ? { RunAgents: RUN_AGENTS_IN_CHAT } : {};
  }

  /** The MCP tools this session can use: a code session's own and the user's, a chat's user-level ones, none in incognito. */
  mcpTools(model: ModelInfo): string[] {
    const inputs = this.inputs();
    return inputs.kind === 'code' ? inputs.mcpToolNames(inputs.settingsRoot) : inputs.incognito || !model.supportsTools ? [] : inputs.mcpToolNames(null);
  }

  /**
   * MCP tools whose definitions would weigh on every request (a big setup: GitHub's
   * has dozens) are not sent until the agent searches for them with ToolSearch.
   * The choice is made once, so the tools and the prompt stay the same between turns.
   */
  splitMcp(mcpTools: string[], model: ModelInfo): { offered: string[]; deferred: string[] } {
    if (mcpTools.length === 0) return { offered: [], deferred: [] };
    if (!this.deferredAll) {
      const weight = estimateTextTokens(JSON.stringify(this.inputs().registry.specs(mcpTools)));
      if (weight > Math.min(DEFER_MCP_TOKENS, Math.floor(model.contextWindow * 0.1))) this.deferredAll = true;
    }
    if (!this.deferredAll) return { offered: mcpTools, deferred: [] };
    return { offered: mcpTools.filter((n) => this.loaded.has(n)), deferred: mcpTools.filter((n) => !this.loaded.has(n)) };
  }

  /** Whether a big setup keeps its MCP tools waiting for ToolSearch. */
  get deferring(): boolean {
    return this.deferredAll;
  }

  /** Marks tools as loaded with ToolSearch, so this session offers them from its next request on. */
  load(names: string[]): void {
    for (const name of names) this.loaded.add(name);
  }

  /** How many tools of each server are waiting, for the prompt. */
  deferredByServer(model: ModelInfo): Array<{ server: string; count: number }> {
    const inputs = this.inputs();
    const { deferred } = this.splitMcp(this.mcpTools(model), model);
    const counts = new Map<string, number>();
    for (const name of deferred) {
      const server = inputs.registry.get(name)?.mcp?.server ?? 'other';
      counts.set(server, (counts.get(server) ?? 0) + 1);
    }
    return [...counts].map(([server, count]) => ({ server, count }));
  }

  /** The tools waiting to be loaded, as ToolSearch searches them. */
  deferredEntries(): SearchableTool[] {
    const inputs = this.inputs();
    const names = inputs.kind === 'code' ? inputs.mcpToolNames(inputs.settingsRoot) : inputs.mcpToolNames(null);
    return names
      .filter((n) => !this.loaded.has(n))
      .flatMap((name) => {
        const tool = inputs.registry.get(name);
        return tool ? [{ name, server: tool.mcp?.server ?? '', description: tool.description }] : [];
      });
  }
}
