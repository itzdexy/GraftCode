import { describe, expect, it } from 'vitest';
import { BUDGET_CHOICES, budgetLabel, modelKey, modelOfKey, roleModelOptions } from '../../../src/renderer/src/features/settings/agentSettings';
import type { ModelInfo } from '../../../src/shared/schemas/models';

function model(providerId: string, modelId: string, extra: Partial<ModelInfo> = {}): ModelInfo {
  return {
    ref: { providerId, modelId },
    label: modelId,
    description: '',
    family: modelId,
    contextWindow: 200_000,
    maxOutputTokens: 8_000,
    supportsTools: true,
    supportsVision: true,
    supportsWebSearch: false,
    effort: null,
    featured: true,
    cheap: false,
    createdAt: null,
    pricing: null,
    ...extra
  };
}

const opus = model('anthropic', 'opus', { label: 'Opus' });
const haiku = model('anthropic', 'haiku', { label: 'Haiku' });
const blind = model('local', 'coder', { label: 'Coder', supportsVision: false });
const chatOnly = model('local', 'talker', { label: 'Talker', supportsTools: false });
const all = [opus, haiku, blind, chatOnly];
const providers = { anthropic: 'Anthropic', local: 'Ollama' };

describe('choosing a model for a kind of agent work', () => {
  it('offers every model that can use tools, after the choice to leave it to routing', () => {
    expect(roleModelOptions('coder', all, null, 'session', providers)).toEqual([
      { value: '', label: 'The session’s model' },
      { value: modelKey(opus.ref), label: 'Opus · Anthropic' },
      { value: modelKey(haiku.ref), label: 'Haiku · Anthropic' },
      { value: modelKey(blind.ref), label: 'Coder · Ollama' }
    ]);
  });

  it('says what leaving it alone means when routing is automatic', () => {
    expect(roleModelOptions('fast', all, null, 'auto', providers)[0]).toEqual({ value: '', label: 'Automatic' });
  });

  it('offers only models that see images for the work that looks at screens', () => {
    expect(roleModelOptions('vision', all, null, 'session', providers).map((o) => o.label)).toEqual(['The session’s model', 'Opus · Anthropic', 'Haiku · Anthropic']);
  });

  it('leaves out the provider when there is only one', () => {
    expect(roleModelOptions('coder', [opus, haiku], null, 'session', { anthropic: 'Anthropic' }).map((o) => o.label)).toEqual(['The session’s model', 'Opus', 'Haiku']);
  });

  it('keeps showing a chosen model that is no longer offered, and says it is gone', () => {
    const gone = { providerId: 'anthropic', modelId: 'retired' };
    const options = roleModelOptions('coder', [opus], gone, 'session', providers);
    expect(options.at(-1)).toEqual({ value: modelKey(gone), label: 'retired (no longer available)' });
  });

  it('reads a choice back as the model it names', () => {
    expect(modelOfKey(modelKey(haiku.ref), all)).toEqual(haiku.ref);
    expect(modelOfKey('', all)).toBeNull();
    expect(modelOfKey('nothing', all)).toBeNull();
  });

  it('words a token budget, and offers the one in use even when it is not a usual amount', () => {
    expect(budgetLabel(null)).toBe('No limit');
    expect(budgetLabel(500_000)).toBe('500K tokens');
    expect(budgetLabel(2_000_000)).toBe('2M tokens');
    expect(BUDGET_CHOICES).toContain(null);
    expect(BUDGET_CHOICES.every((n) => n === null || (n >= 10_000 && n <= 50_000_000))).toBe(true);
  });
});
