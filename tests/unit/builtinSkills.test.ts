import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SKILL = path.resolve(__dirname, '../../resources/skills/diagram-design');

function files(dir: string, base = dir): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? files(full, base) : [path.relative(base, full).split(path.sep).join('/')];
  });
}
const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

describe('the bundled diagram-design skill', () => {
  it("is upstream's folder at the pinned commit, unchanged", () => {
    const upstream = JSON.parse(fs.readFileSync(path.join(SKILL, 'UPSTREAM.json'), 'utf8')) as Record<string, string>;
    expect(upstream).toMatchObject({ repository: 'https://github.com/cathrynlavery/diagram-design', commit: '7a2e22170ee838e859d8142ba825d83f8b6375e6', version: '2.6.74' });
    const names = files(SKILL).filter((f) => f !== 'UPSTREAM.json').sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(sha(names.map((f) => `${sha(fs.readFileSync(path.join(SKILL, f)))}  ${f}\n`).join(''))).toBe(upstream.treeHash);
    for (const f of ['SKILL.md', 'LICENSE', 'THIRD_PARTY_LICENSES.md', 'references/style-guide.md', 'references/profiles.md', 'assets/template.html']) expect(names).toContain(f);
    expect(names.length).toBeGreaterThan(250);
    expect(fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8')).toMatch(/^---\r?\nname: diagram-design\r?\n/);
  });
});
