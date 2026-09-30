import type { ProviderKind } from './schemas/common';

export interface ProviderKindInfo {
  kind: ProviderKind;
  name: string;
  description: string;
  /** 'required' | 'optional' | 'none' */
  key: 'required' | 'optional' | 'none';
  baseUrl: 'required' | 'optional' | 'hidden';
  defaultBaseUrl: string | null;
  keyPlaceholder: string;
  keyHelpUrl: string | null;
}

export const PROVIDER_KIND_INFO: Record<ProviderKind, ProviderKindInfo> = {
  anthropic: {
    kind: 'anthropic',
    name: 'Anthropic',
    description: 'API access with an Anthropic Console key.',
    key: 'required',
    baseUrl: 'hidden',
    defaultBaseUrl: 'https://api.anthropic.com',
    keyPlaceholder: 'sk-ant-…',
    keyHelpUrl: 'https://console.anthropic.com/settings/keys'
  },
  openai: {
    kind: 'openai',
    name: 'OpenAI',
    description: 'API access with an OpenAI platform key.',
    key: 'required',
    baseUrl: 'hidden',
    defaultBaseUrl: 'https://api.openai.com/v1',
    keyPlaceholder: 'sk-…',
    keyHelpUrl: 'https://platform.openai.com/api-keys'
  },
  gemini: {
    kind: 'gemini',
    name: 'Google Gemini',
    description: 'API access with a Google AI Studio key.',
    key: 'required',
    baseUrl: 'hidden',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    keyPlaceholder: 'AIza…',
    keyHelpUrl: 'https://aistudio.google.com/apikey'
  },
  openrouter: {
    kind: 'openrouter',
    name: 'OpenRouter',
    description: 'One key for many hosted models.',
    key: 'required',
    baseUrl: 'hidden',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    keyPlaceholder: 'sk-or-…',
    keyHelpUrl: 'https://openrouter.ai/keys'
  },
  ollama: {
    kind: 'ollama',
    name: 'Ollama',
    description: 'Models running locally on this machine. No key needed.',
    key: 'none',
    baseUrl: 'optional',
    defaultBaseUrl: 'http://localhost:11434',
    keyPlaceholder: '',
    keyHelpUrl: null
  },
  'openai-compatible': {
    kind: 'openai-compatible',
    name: 'Custom endpoint',
    description: 'Any server that speaks the OpenAI chat completions API.',
    key: 'optional',
    baseUrl: 'required',
    defaultBaseUrl: null,
    keyPlaceholder: 'Optional',
    keyHelpUrl: null
  }
};
