import { describe, expect, it } from 'vitest';
import { coveredLines, findSecrets, lastLines, maskSecrets, splitSecrets } from '../../src/shared/secrets';

/** The parts of `text` that would be covered. */
function covered(text: string): string[] {
  return findSecrets(text).map((s) => text.slice(s.start, s.end));
}

// Made-up values in the shape of real keys; none of them was ever issued.
const ANTHROPIC = `sk-ant-api03-${'a1B2c3D4'.repeat(6)}`;
const OPENROUTER = `sk-or-v1-${'0123456789abcdef'.repeat(4)}`;
const GITHUB = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
const JWT = `eyJhbGciOiJIUzI1NiJ9.${'eyJzdWIiOiIxMjM0NTY3ODkwIn0'}.${'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV'}`;
const TOKEN = 'abcDEF0123456789abcDEF0123456789';
const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

describe('keys and tokens in text', () => {
  it('finds the keys providers and services issue, by their shape', () => {
    expect(covered(`ANTHROPIC key is ${ANTHROPIC} ok`)).toEqual([ANTHROPIC]);
    expect(covered(`curl -H "x: ${OPENROUTER}"`)).toEqual([OPENROUTER]);
    expect(covered(`token ${GITHUB}`)).toEqual([GITHUB]);
    expect(covered('aws AKIAIOSFODNN7EXAMPLE here')).toEqual(['AKIAIOSFODNN7EXAMPLE']);
    expect(covered(`google AIza${'Sy0123456789abcdefghijklmnopqrstuvw'}`)).toHaveLength(1);
    expect(covered(`jwt ${JWT}`)).toEqual([JWT]);
    expect(covered('gitlab glpat-abcdefghij1234567890 ok')).toEqual(['glpat-abcdefghij1234567890']);
  });

  it('covers the value of a header or an assignment, not its name', () => {
    expect(covered(`Authorization: Bearer ${TOKEN}`)).toEqual([TOKEN]);
    expect(covered(`OPENAI_API_KEY=${TOKEN}`)).toEqual([TOKEN]);
    expect(covered(`export DB_PASSWORD="${TOKEN}"`)).toEqual([TOKEN]);
    expect(covered(`"clientSecret": "${TOKEN}"`)).toEqual([TOKEN]);
    // Inside a JSON string, quotes arrive escaped.
    expect(covered(`{\\"access_token\\":\\"${TOKEN}\\"}`)).toEqual([TOKEN]);
    // A password is shorter than a key and may hold punctuation.
    expect(covered('PGPASSWORD=s3cretPass!')).toEqual(['s3cretPass!']);
    expect(covered('password=MyDogRex2019$extra')).toEqual(['MyDogRex2019$extra']);
    expect(covered('"password": "hunter42",')).toEqual(['hunter42']);
  });

  it('covers the secrets that the first version let through', () => {
    // The secret half of an AWS key pair, in a credentials file and in the environment.
    expect(covered(`aws_secret_access_key = ${AWS_SECRET}`)).toEqual([AWS_SECRET]);
    expect(covered(`AWS_SECRET_ACCESS_KEY=${AWS_SECRET}`)).toEqual([AWS_SECRET]);
    // An environment variable whose value has dots, dashes or colons.
    expect(covered('SECRET_KEY=django-insecure-abc123xyz')).toEqual(['django-insecure-abc123xyz']);
    expect(covered('DISCORD_TOKEN=abc123.def456.ghi789')).toEqual(['abc123.def456.ghi789']);
    // The password in an address, whatever the variable is called.
    expect(covered('DATABASE_URL=postgres://admin:S3cretPassw0rd99@db.example.com:5432/app')).toEqual(['S3cretPassw0rd99']);
    expect(covered('git clone https://deploy:tok3nValue@git.example.com/a/b.git')).toEqual(['tok3nValue']);
  });

  it('covers a private key from its first line to its last', () => {
    const block = ['-----BEGIN OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1rZXktdjEAAAAA', 'AAAAB3NzaC1yc2EAAAADAQAB', 'Zm9v', '-----END OPENSSH PRIVATE KEY-----'].join('\n');
    expect(covered(`before\n${block}\nafter`)).toEqual([block]);
    const armoured = ['-----BEGIN PGP PRIVATE KEY BLOCK-----', 'Version: GnuPG v2', '', 'lQOYBGZ1x2ABCADJq8Zk3n9c3NoLXJzYQAA', 'AMBAAEAAAEBAQDFq8Zk3n9c3NoLXJzYQAA', '=AbCd', '-----END PGP PRIVATE KEY BLOCK-----'].join('\r\n');
    expect(covered(`x\r\n${armoured}\r\ny`)).toEqual([armoured]);
  });

  it('covers what there is of a private key that was cut short at either end', () => {
    const cut = ['key:', '-----BEGIN RSA PRIVATE KEY-----', 'MIIEpAIBAAKCAQEA7x3Jk2n9', 'c3NoLXJzYQAAAAMBAAEAAAEB', '[… 40 lines left out …]', 'done'].join('\n');
    expect(covered(cut)).toEqual(['-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA7x3Jk2n9\nc3NoLXJzYQAAAAMBAAEAAAEB']);
    // Only the end of a long output is shown: the last lines of the key, and its last line.
    const tail = ['c3NoLXJzYQAAAAMBAAEAAAEB', 'MIIEpAIBAAKCAQEA7x3Jk2n9', 'Zm9v', '-----END RSA PRIVATE KEY-----', '$'].join('\n');
    expect(covered(`…\n${tail}`)).toEqual(['c3NoLXJzYQAAAAMBAAEAAAEB\nMIIEpAIBAAKCAQEA7x3Jk2n9\nZm9v\n-----END RSA PRIVATE KEY-----']);
  });

  it('covers nothing when a key is only named', () => {
    // A search that lists the files holding a key shows no key material.
    const listed = ['certs/a.pem:1:-----BEGIN PRIVATE KEY-----', 'certs/b.pem:1:-----BEGIN PRIVATE KEY-----', 'README.md:40:paste the line -----BEGIN PRIVATE KEY----- first'].join('\n');
    expect(covered(listed)).toEqual([]);
    // Source that holds both markers as constants has ordinary code between them.
    const source = ["const BEGIN = '-----BEGIN PRIVATE KEY-----';", 'export function wrap(body: string): string {', '  return [BEGIN, body, END].join(String.fromCharCode(10));', '}', "const END = '-----END PRIVATE KEY-----';"].join('\n');
    expect(covered(source)).toEqual([]);
  });

  it('leaves alone what only looks a little like a secret', () => {
    for (const plain of [
      'MAX_TOKENS=4096',
      'TOKEN_LIMIT: 200000',
      'KEYBOARD_LAYOUT=us104international',
      'API_KEY=process.env.API_KEY',
      'const apiKey = settings.apiKey;',
      'password: string;',
      'password: z.string().min(8),',
      'passwordMinLength = 12345678',
      'pwd = getcwd1234()',
      'password = readPassword1(prompt)',
      'const token = computeSessionToken2(user);',
      'const token = useAuthToken2FA_handler;',
      'apiKey: providers.primary2.apiKeyValue,',
      'secret: /var/lib/app2/data/keys',
      'GITHUB_TOKEN=${{ secrets.GITHUB_TOKEN }}',
      'sk-short',
      'git checkout sk-refactor-transcript-view-menu',
      'the task-runner skipped 4 files',
      'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      'commit 3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39',
      'http://localhost:3000/@scope/package',
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

  it('shows a vendor’s prefix while covered, and nothing of a password', () => {
    expect(maskSecrets(`key ${ANTHROPIC}.`)).toBe('key sk-ant••••••••.');
    expect(maskSecrets(`a ${GITHUB} b ${OPENROUTER}`)).toBe('a ghp_A1•••••••• b sk-or-••••••••');
    // Found by its name and by its shape at once: one cover, with the prefix.
    expect(maskSecrets(`ANTHROPIC_API_KEY=${ANTHROPIC}`)).toBe('ANTHROPIC_API_KEY=sk-ant••••••••');
    expect(maskSecrets('password=hunter42')).toBe('password=••••••••');
    expect(maskSecrets('password: Summer2024!')).toBe('password: ••••••••');
    expect(maskSecrets(`Authorization: Bearer ${TOKEN}`)).toBe('Authorization: Bearer ••••••••');
    expect(maskSecrets('nothing here')).toBe('nothing here');
  });

  it('splits text into plain and secret pieces that add up to the text', () => {
    const text = `a ${GITHUB} b`;
    const pieces = splitSecrets(text);
    expect(pieces.map((p) => p.secret)).toEqual([false, true, false]);
    expect(pieces.map((p) => p.text).join('')).toBe(text);
    expect(pieces.map((p) => p.cover).join('')).toBe('a ghp_A1•••••••• b');
    expect(splitSecrets('plain')).toEqual([{ text: 'plain', secret: false, cover: 'plain' }]);
    expect(splitSecrets('')).toEqual([]);
  });

  it('folds a long output to its last lines after covering, so the end of a key stays covered', () => {
    const key = ['-----BEGIN RSA PRIVATE KEY-----', ...Array.from({ length: 30 }, (_, i) => `MIIEpAIBAAKCAQEA7x3Jk2n9line${String(i).padStart(2, '0')}`), '-----END RSA PRIVATE KEY-----'];
    const output = ['$ cat id_rsa', ...key, 'exit 0'].join('\n');
    const folded = lastLines(splitSecrets(output), 14);
    // Fourteen lines: twelve of key material, its last line, and the line after. None of the key is readable.
    const shown = folded.map((p) => p.cover).join('');
    expect(shown).toBe('••••••••\nexit 0');
    expect(folded.map((p) => p.text).join('').split('\n')).toHaveLength(14);
    // Revealed, the fold shows exactly the last fourteen lines of the output.
    expect(folded.map((p) => p.text).join('')).toBe(output.split('\n').slice(-14).join('\n'));

    const plain = splitSecrets('a\nb\nc');
    expect(lastLines(plain, 2).map((p) => p.text).join('')).toBe('b\nc');
    expect(lastLines(plain, 5)).toBe(plain);
  });

  it('covers a text line by line for what is shown line by line', () => {
    const text = ['PORT=3000', `OPENAI_API_KEY=${ANTHROPIC}`, 'DEBUG=1'].join('\n');
    expect(coveredLines(text)).toEqual({ lines: ['PORT=3000', 'OPENAI_API_KEY=sk-ant••••••••', 'DEBUG=1'], covered: [false, true, false] });
    // A secret over several lines is covered on each, and the lines around it keep their places.
    const block = ['-----BEGIN OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1rZXktdjEAAAAA', 'AAAAB3NzaC1yc2EAAAADAQAB', '-----END OPENSSH PRIVATE KEY-----'].join('\n');
    expect(coveredLines(`# key\n${block}\n# end`)).toEqual({ lines: ['# key', '••••••••', '••••••••', '••••••••', '••••••••', '# end'], covered: [false, true, true, true, true, false] });
    expect(coveredLines('')).toEqual({ lines: [''], covered: [false] });
    expect(coveredLines('a\n\nb')).toEqual({ lines: ['a', '', 'b'], covered: [false, false, false] });
  });

  it('stays fast on long lines built against its patterns', () => {
    const started = performance.now();
    const hostile = [
      Array.from({ length: 20_000 }, (_, i) => `keys/${String(i)}.pem:1:-----BEGIN PRIVATE KEY-----`).join('\n'),
      `token=${'a1'.repeat(200_000)}(`,
      'eyJ-'.repeat(25_000),
      `${'token='.repeat(16_000)}.`,
      `${'password='.repeat(11_000)}.`,
      `${'SECRET_KEY='.repeat(9_000)}.`,
      `${'sk-'.repeat(33_000)}`,
      'https://a:'.repeat(10_000)
    ];
    for (const text of hostile) findSecrets(text);
    // Around a tenth of a second in all when every scan is bounded; many seconds when one is not.
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});
