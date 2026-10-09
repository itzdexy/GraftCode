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
  it('keeps useful diagnostics', () => { expect(redact('Provider timed out status=503 model=alpha')).toBe('Provider timed out status=503 model=alpha'); });
});
