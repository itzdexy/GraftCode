import { describe, expect, it } from 'vitest';
import { findSecrets, maskSecrets, splitSecrets } from '../../src/shared/secrets';

/** The parts of `text` that would be covered. */
function covered(text: string): string[] {
  return findSecrets(text).map((s) => text.slice(s.start, s.end));
}

// Made-up values in the shape of real keys; none of them was ever issued.
const ANTHROPIC = `sk-ant-api03-${'a1B2c3D4'.repeat(6)}`;
const OPENROUTER = `sk-or-v1-${'0123456789abcdef'.repeat(4)}`;
const GITHUB = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
const JWT = `eyJhbGciOiJIUzI1NiJ9.${'eyJzdWIiOiIxMjM0NTY3ODkwIn0'}.${'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV'}`;

describe('keys and tokens in text', () => {
  it('finds the keys providers and services issue, by their shape', () => {
    expect(covered(`ANTHROPIC key is ${ANTHROPIC} ok`)).toEqual([ANTHROPIC]);
    expect(covered(`curl -H "x: ${OPENROUTER}"`)).toEqual([OPENROUTER]);
    expect(covered(`token ${GITHUB}`)).toEqual([GITHUB]);
    expect(covered('aws AKIAIOSFODNN7EXAMPLE here')).toEqual(['AKIAIOSFODNN7EXAMPLE']);
    expect(covered(`google AIza${'Sy0123456789abcdefghijklmnopqrstuvw'}`)).toHaveLength(1);
    expect(covered(`jwt ${JWT}`)).toEqual([JWT]);
  });

  it('covers the value of a header or an assignment, not its name', () => {
    const token = 'abcDEF0123456789abcDEF0123456789';
    expect(covered(`Authorization: Bearer ${token}`)).toEqual([token]);
    expect(covered(`OPENAI_API_KEY=${token}`)).toEqual([token]);
    expect(covered(`export DB_PASSWORD="${token}"`)).toEqual([token]);
    expect(covered(`"clientSecret": "${token}"`)).toEqual([token]);
    // A password is shorter than a key and may hold punctuation.
    expect(covered('PGPASSWORD=s3cretPass!')).toEqual(['s3cretPass!']);
  });

  it('covers a private key from its first line to its last', () => {
    const block = ['-----BEGIN OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1rZXktdjEAAAAA', 'AAAAB3NzaC1yc2EAAAADAQAB', '-----END OPENSSH PRIVATE KEY-----'].join('\n');
    expect(covered(`before\n${block}\nafter`)).toEqual([block]);
  });

  it('leaves alone what only looks a little like a secret', () => {
    for (const plain of [
      'MAX_TOKENS=4096',
      'TOKEN_LIMIT: 200000',
      'API_KEY=process.env.API_KEY',
      'const apiKey = settings.apiKey;',
      'password: string;',
      'password: z.string().min(8),',
      'passwordMinLength = 12345678',
      'pwd = getcwd1234()',
      'password = readPassword1(prompt)',
      'const token = computeSessionToken2(user);',
      'apiKey: providers.primary2.apiKeyValue,',
      'GITHUB_TOKEN=${{ secrets.GITHUB_TOKEN }}',
      'sk-short',
      'the task-runner skipped 4 files',
      'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      'commit 3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39',
      'C:/Users/dexy/code/demo/src/main/agent/sessionManager.ts'
    ]) {
      expect(covered(plain), plain).toEqual([]);
    }
  });

  it('reports each secret once, in order, even when two patterns match it', () => {
    const text = `ANTHROPIC_API_KEY=${ANTHROPIC} and again ${ANTHROPIC}`;
    const spans = findSecrets(text);
    expect(spans).toHaveLength(2);
    expect(spans[0]!.end).toBeLessThanOrEqual(spans[1]!.start);
  });

  it('covers a secret with dots after a few of its characters, whatever its length', () => {
    expect(maskSecrets(`key ${ANTHROPIC}.`)).toBe('key sk-ant••••••••.');
    expect(maskSecrets(`a ${GITHUB} b ${OPENROUTER}`)).toBe('a ghp_A1••••••••  b sk-or-••••••••'.replace('  ', ' '));
    expect(maskSecrets('nothing here')).toBe('nothing here');
  });

  it('splits text into plain and secret pieces that add up to the text', () => {
    const text = `a ${GITHUB} b`;
    const pieces = splitSecrets(text);
    expect(pieces.map((p) => p.secret)).toEqual([false, true, false]);
    expect(pieces.map((p) => p.text).join('')).toBe(text);
    expect(splitSecrets('plain')).toEqual([{ text: 'plain', secret: false }]);
    expect(splitSecrets('')).toEqual([]);
  });
});
