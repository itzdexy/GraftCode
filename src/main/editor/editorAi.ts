import { GraftError } from '@shared/errors';
import type { AppSettings } from '@shared/schemas/appSettings';
import type { ModelInfo } from '@shared/schemas/models';
import type { SessionSummary } from '@shared/schemas/sessions';
import { findSecrets, maskSecrets } from '@shared/secrets';
import { mediaTurnKind } from '../agent/loop';
import { titleModel } from '../agent/title';
import { isCredentialPath } from '../permissions/dangerous';
import { ProviderError } from '../providers/errors';
import { streamWithRetry } from '../providers/retry';
import type { LLMProvider, RequestPrivacy } from '../providers/types';
import { cleanCompletion, cleanReplacement, COMPLETION_SYSTEM, completionInput, COVER, EDIT_SYSTEM, editInput, maskParts, windowAfter, windowBefore, type EditRequest } from './completions';

export interface EditorAiDeps {
  settings(): AppSettings;
  session(id: string): SessionSummary;
  models(providerId: string, signal: AbortSignal): Promise<ModelInfo[]>;
  provider(providerId: string): LLMProvider;
}

export interface CompletionRequest {
  sessionId: string;
  requestId: string;
  file: string;
  language: string;
  /** The text before and after the cursor; the request is written from a window of them. */
  prefix: string;
  suffix: string;
}

const SECRET_FILE = 'This file may hold keys or passwords, so Graft does not send it to a model.';
/** How long a suggestion and an edit may take before they are given up. */
const SUGGEST_MS = 20_000;
const EDIT_MS = 120_000;
/** A suggestion is cut well before this; an edit that runs past it is stopped rather than shown cut off. */
const SUGGEST_CHARS = 4_000;
const EDIT_CHARS = 60_000;

/**
 * The Files editor's AI in the main process: suggestions as you type on a fast model, and Edit with AI on the
 * session's own model. Both follow the git:suggestCommitMessage handler: the session's provider, the Privacy
 * setting, errors as sentences. Every request can be cancelled by its id, also before it has arrived.
 */
export class EditorAi {
  private readonly running = new Map<string, AbortController>();
  /** Requests cancelled before they came: the renderer sends a cancel right behind the request it ends. */
  private readonly cancelled = new Set<string>();

  constructor(private readonly deps: EditorAiDeps) {}

  /** The text that belongs at the cursor; empty when there is nothing useful to add. */
  async complete(input: CompletionRequest): Promise<{ text: string }> {
    if (!this.deps.settings().editor.suggestions) return { text: '' };
    this.codeSession(input.sessionId);
    if (isCredentialPath(input.file)) throw new GraftError('secret_file', SECRET_FILE);
    const [before = '', after = ''] = maskParts([windowBefore(input.prefix), windowAfter(input.suffix)]);
    return this.run(input.requestId, SUGGEST_MS, async (signal) => {
      const { provider, model } = await this.suggestionModel(input.sessionId, signal);
      const { text } = await ask(provider, model, COMPLETION_SYSTEM, completionInput(input.file, input.language, before, after), signal, this.privacy(), {
        maxChars: SUGGEST_CHARS,
        retries: 0,
        cacheKey: `${input.sessionId}:suggest`
      });
      return { text: cleanCompletion(text, before, after) };
    });
  }

  /** New text for the selected lines, written by the session's model; nothing in the file changes here. */
  async inlineEdit(input: EditRequest & { sessionId: string; requestId: string }): Promise<{ replacement: string }> {
    this.codeSession(input.sessionId);
    if (isCredentialPath(input.file)) throw new GraftError('secret_file', SECRET_FILE);
    // The lines that are rewritten can't be sent covered: the dots would come back in place of the key.
    if (findSecrets(input.selection).length > 0 || (input.proposal !== undefined && findSecrets(input.proposal).length > 0)) {
      throw new GraftError('secret_in_selection', 'The selected lines look like they hold a key or a password, so Graft does not send them to a model. Change them by hand.');
    }
    const request: EditRequest = { ...input, before: maskSecrets(windowBefore(input.before)), after: maskSecrets(windowAfter(input.after)) };
    const { text, cut } = await this.run(input.requestId, EDIT_MS, async (signal) => {
      const { provider, current } = await this.sessionModel(input.sessionId, signal);
      return ask(provider, current, EDIT_SYSTEM, editInput(request), signal, this.privacy(), { maxChars: EDIT_CHARS, retries: 1, cacheKey: `${input.sessionId}:edit` });
    });
    if (cut) throw new GraftError('edit_too_long', 'The proposal grew too long and was stopped. Select fewer lines or ask for a smaller change.');
    const replacement = cleanReplacement(text, input.selection);
    if (!replacement.trim()) throw new GraftError('edit_empty', 'The model sent back no code. Say what to change in another way.');
    if (replacement.includes(COVER)) throw new GraftError('edit_covered', 'The proposal contains a covered key or password, so it cannot be applied. Ask again, or change those lines by hand.');
    return { replacement };
  }

  /** The model suggestions come from for a file, or why there are none, for the editor's toolbar. */
  async model(sessionId: string, file: string): Promise<{ label: string | null; note: string | null }> {
    if (isCredentialPath(file)) return { label: null, note: 'Suggestions are off for this file: it may hold keys or passwords.' };
    try {
      return { label: (await this.suggestionModel(sessionId, AbortSignal.timeout(15_000))).model.label, note: null };
    } catch (error) {
      if (error instanceof GraftError) return { label: null, note: error.message };
      throw error;
    }
  }

  cancel(requestId: string): void {
    const running = this.running.get(requestId);
    if (running) {
      running.abort();
      return;
    }
    this.cancelled.add(requestId);
    // A cancel whose request never comes is forgotten in time.
    for (const old of this.cancelled) {
      if (this.cancelled.size <= 100) break;
      this.cancelled.delete(old);
    }
  }

  private async run<T>(requestId: string, ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.cancelled.delete(requestId)) throw new GraftError('cancelled', 'The request was cancelled.');
    const controller = new AbortController();
    this.running.set(requestId, controller);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(ms)]);
    try {
      return await work(signal);
    } catch (error) {
      if (controller.signal.aborted) throw new GraftError('cancelled', 'The request was cancelled.');
      if (signal.aborted) throw new GraftError('timeout', 'The model took too long to answer. Try again in a moment.');
      if (error instanceof ProviderError) throw new GraftError(`provider_${error.code}`, error.message, { cause: error });
      throw error;
    } finally {
      this.running.delete(requestId);
    }
  }

  private codeSession(sessionId: string): void {
    if (this.deps.session(sessionId).kind !== 'code') throw new GraftError('no_folder', 'Only code-session project files can be edited here.');
  }

  /** As the commit message is asked for: the Privacy setting decides. */
  private privacy(): RequestPrivacy {
    return { noTraining: this.deps.settings().privacy.noTraining, zeroRetention: false };
  }

  private async sessionModel(sessionId: string, signal: AbortSignal): Promise<{ provider: LLMProvider; current: ModelInfo; models: ModelInfo[] }> {
    const ref = this.deps.session(sessionId).model ?? this.deps.settings().defaults.model;
    if (!ref) throw new GraftError('no_model', 'Choose a model for this session first.');
    const models = await this.deps.models(ref.providerId, signal);
    const current = models.find((m) => m.ref.modelId === ref.modelId);
    if (!current) throw new GraftError('model_not_found', `The model ${ref.modelId} is no longer available.`);
    if (mediaTurnKind(current.ref.modelId) !== null) throw new GraftError('media_model', `${current.label} makes pictures or video, not code. Switch the session to a text model first.`);
    return { provider: this.deps.provider(ref.providerId), current, models };
  }

  /** The model chosen for suggestions in Settings, else the cheap tier of the session's provider. */
  private async suggestionModel(sessionId: string, signal: AbortSignal): Promise<{ provider: LLMProvider; model: ModelInfo }> {
    const chosen = this.deps.settings().editor.suggestionModel;
    if (!chosen) {
      const { provider, current, models } = await this.sessionModel(sessionId, signal);
      return { provider, model: titleModel(current, models) };
    }
    const model = (await this.deps.models(chosen.providerId, signal)).find((m) => m.ref.modelId === chosen.modelId);
    if (!model || mediaTurnKind(model.ref.modelId) !== null) {
      throw new GraftError('model_not_found', `The model for suggestions, ${chosen.modelId}, is not available. Choose another in Settings → Models.`);
    }
    return { provider: this.deps.provider(chosen.providerId), model };
  }
}

/** One streamed answer, stopped once it runs past `maxChars`; `cut` says it was. */
async function ask(
  provider: LLMProvider,
  model: ModelInfo,
  system: string,
  input: string,
  signal: AbortSignal,
  privacy: RequestPrivacy,
  options: { maxChars: number; retries: number; cacheKey: string }
): Promise<{ text: string; cut: boolean }> {
  const stop = new AbortController();
  let streamed = '';
  let whole = '';
  try {
    for await (const event of streamWithRetry(
      provider,
      {
        model,
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
        tools: [],
        effort: model.effort ? (model.effort.levels[0] ?? null) : null,
        webSearch: false,
        cacheKey: options.cacheKey,
        privacy
      },
      AbortSignal.any([signal, stop.signal]),
      () => undefined,
      { maxRetries: options.retries, baseDelayMs: 500, maxDelayMs: 2_000, maxRetryAfterMs: 2_000 }
    )) {
      if (event.type === 'block' && event.block.type === 'text') whole += event.block.text;
      else if (event.type === 'text-delta') {
        streamed += event.text;
        if (streamed.length > options.maxChars) {
          stop.abort();
          break;
        }
      }
    }
  } catch (error) {
    if (!stop.signal.aborted || signal.aborted) throw error;
  }
  return { text: stop.signal.aborted ? streamed : whole || streamed, cut: stop.signal.aborted };
}
