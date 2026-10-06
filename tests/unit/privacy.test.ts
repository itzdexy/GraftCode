import { describe, expect, it } from 'vitest';
import { dataHandling, isLocalUrl, isPrivateAddress, isPrivateIp } from '../../src/shared/privacy';
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

describe('an address on this computer or a private network', () => {
  it('is known by its number or its name, however the number is written', () => {
    const inside = [
      'http://localhost:3000/',
      'http://app.localhost/',
      'http://127.0.0.1/',
      'http://127.8.9.1:8080/x',
      'http://2130706433/',
      'http://0x7f.1/',
      'http://0.0.0.0/',
      'http://10.1.2.3/',
      'http://172.16.0.1/',
      'http://172.31.255.1/',
      'http://192.168.1.1/admin',
      'http://169.254.169.254/latest/meta-data',
      'http://100.64.0.1/',
      'http://[::1]/',
      'http://[::]/',
      'http://[fd00::1]/',
      'http://[fe80::1]/',
      'http://[::ffff:192.168.1.1]/',
      'http://printer.local/',
      'http://nas.lan/',
      'http://service.internal/',
      'http://router.home.arpa/',
      'http://intranet/',
      'http://[::127.0.0.1]/',
      'http://db.corp/',
      'http://nas.home/',
      'http://host.localdomain/',
      'http://myapp.test/',
      'http://printer.invalid/'
    ];
    for (const url of inside) expect(isPrivateAddress(url), url).toBe(true);
    const outside = ['https://example.com/', 'https://8.8.8.8/', 'http://172.32.0.1/', 'http://11.0.0.1/', 'http://192.169.1.1/', 'https://localhost.example.com/', 'https://[2606:4700::1111]/', 'https://[::ffff:8.8.8.8]/'];
    for (const url of outside) expect(isPrivateAddress(url), url).toBe(false);
    // Not an address at all: nothing to guard, and nothing to fetch either.
    expect(isPrivateAddress('not a url')).toBe(false);
    expect(['127.0.0.1', '10.0.0.5', '::1', 'fe80::1%eth0', '8.8.8.8', '2606:4700::1111'].map(isPrivateIp)).toEqual([true, true, true, true, false, false]);
  });
});
