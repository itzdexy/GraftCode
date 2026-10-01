import { describe, expect, it } from 'vitest';
import { dataHandling, isLocalUrl } from '../../src/shared/privacy';
import type { SessionSummary } from '../../src/shared/schemas/sessions';
import { EMPTY_SESSION_USAGE } from '../../src/main/db/sessionsRepo';
import { notificationContent } from '../../src/main/app/notifications';

describe('where data goes', () => {
  it('classifies providers by kind and endpoint', () => {
    expect(dataHandling({ kind: 'ollama', baseUrl: null })).toBe('local');
    expect(dataHandling({ kind: 'ollama', baseUrl: 'http://localhost:11434' })).toBe('local');
    expect(dataHandling({ kind: 'ollama', baseUrl: 'http://192.168.1.20:11434' })).toBe('unknown');
    expect(dataHandling({ kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1' })).toBe('local');
    expect(dataHandling({ kind: 'openai-compatible', baseUrl: 'http://[::1]:8000/v1' })).toBe('local');
    expect(dataHandling({ kind: 'openrouter', baseUrl: null })).toBe('routed');
    expect(dataHandling({ kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' })).toBe('routed');
    expect(dataHandling({ kind: 'anthropic', baseUrl: null })).toBe('no-training');
    expect(dataHandling({ kind: 'openai', baseUrl: 'https://api.openai.com/v1' })).toBe('no-training');
    // A proxy in front of a vendor API is someone else's server.
    expect(dataHandling({ kind: 'openai', baseUrl: 'https://proxy.example.com/v1' })).toBe('unknown');
    expect(dataHandling({ kind: 'gemini', baseUrl: null })).toBe('may-train');
    expect(dataHandling({ kind: 'openai-compatible', baseUrl: 'https://api.deepseek.com' })).toBe('unknown');
    expect(isLocalUrl('http://localhost.example.com')).toBe(false);
  });

  it('keeps incognito chat titles and text out of system notifications', () => {
    const base: SessionSummary = {
      id: 's',
      kind: 'chat',
      title: 'Medical question about my results',
      status: 'idle',
      pinned: false,
      archived: false,
      unread: false,
      incognito: false,
      projectId: null,
      projectPath: null,
      projectName: null,
      cwd: null,
      worktreePath: null,
      branch: null,
      baseBranch: null,
      model: null,
      effort: null,
      permissionMode: 'ask',
      lastError: null,
      usage: EMPTY_SESSION_USAGE,
      createdAt: 0,
      updatedAt: 0
    };
    expect(notificationContent(base, 'finished', 'Your results look normal.')).toEqual({
      title: 'Finished · Medical question about my results',
      body: 'Your results look normal.'
    });
    expect(notificationContent({ ...base, incognito: true }, 'finished', 'Your results look normal.')).toEqual({ title: 'Finished · Incognito chat', body: '' });
  });
});
