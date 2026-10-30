import { describe, expect, it } from 'vitest';
import { redact } from '../../src/main/app/log';

describe('secret redaction', () => {
  it.each([
    'Authorization: Bearer arbitrary-provider-key-123456',
    'Authorization: Bearer tiny',
    'api_key=another-provider-key',
    'access_token=abcde&model=alpha',
    'https://alice:secret@api.test/v1',
    '{"password":"shortpass","secret":"custom-secret"}',
    'x-api-key: custom-authentication-token'
  ])('redacts credentials in %s', (input) => {
    expect(redact(input)).toContain('[redacted]');
    for (const secret of ['arbitrary-provider-key-123456', 'tiny', 'another-provider-key', 'abcde', 'alice:secret', 'shortpass', 'custom-secret', 'custom-authentication-token']) {
      expect(redact(input)).not.toContain(secret);
    }
  });
  it('redacts GitHub tokens, which carry no key name in front of them', () => {
    const classic = `ghp_${'a1B2'.repeat(9)}`;
    const fine = `github_pat_${'Zx9_'.repeat(20)}`;
    const out = redact(`MCP server failed: git clone https://${classic}@github.com/o/r and GH=${fine}`);
    expect(out).not.toContain(classic);
    expect(out).not.toContain(fine);
  });
  it('keeps useful diagnostics', () => { expect(redact('Provider timed out status=503 model=alpha')).toBe('Provider timed out status=503 model=alpha'); });
});
