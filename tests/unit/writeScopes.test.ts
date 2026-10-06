import { describe, expect, it } from 'vitest';
import { anyOverlap, normalizeScope, scopeProblem, scopeRoot, scopesOverlap } from '../../src/shared/writeScopes';
import { inScope, outsideScope } from '../../src/main/agent/writeScope';

describe('the paths an agent may change', () => {
  it('are written one way: forward slashes, no leading ./ and no trailing slash', () => {
    expect(normalizeScope('./src/api/')).toBe('src/api');
    expect(normalizeScope('src\\api\\**')).toBe('src/api/**');
    expect(normalizeScope('  docs/guide.md ')).toBe('docs/guide.md');
  });

  it('are compared by the folder or file before any wildcard', () => {
    expect(scopeRoot('src/api/**')).toBe('src/api');
    expect(scopeRoot('src/**/*.test.ts')).toBe('src');
    expect(scopeRoot('package.json')).toBe('package.json');
    expect(scopeRoot('*.md')).toBe('');
    expect(scopeRoot('src/api/user?.ts')).toBe('src/api');
  });

  it('overlap when one could name a file the other names', () => {
    expect(scopesOverlap('src/api/**', 'src/ui/**')).toBe(false);
    expect(scopesOverlap('src/api', 'src/apiary')).toBe(false);
    expect(scopesOverlap('src/**', 'src/api/users.ts')).toBe(true);
    expect(scopesOverlap('src/api/users.ts', 'src/api')).toBe(true);
    expect(scopesOverlap('package.json', 'package.json')).toBe(true);
    expect(scopesOverlap('docs/**', 'README.md')).toBe(false);
    // Cautious where it can't tell: both of these start at src.
    expect(scopesOverlap('src/**/*.ts', 'src/**/*.css')).toBe(true);
    // Case is ignored, as it is on the file systems most people use.
    expect(scopesOverlap('SRC/Api/**', 'src/api/users.ts')).toBe(true);
    expect(anyOverlap(['src/api/**', 'docs/api.md'], ['src/ui/**', 'docs/ui.md'])).toBe(false);
    expect(anyOverlap(['src/api/**', 'docs/**'], ['src/ui/**', 'docs/ui.md'])).toBe(true);
  });

  it('must be inside the project and narrower than all of it', () => {
    expect(scopeProblem(['src/api/**', 'docs/api.md'])).toBeNull();
    expect(scopeProblem([])).toMatch(/at least one/i);
    expect(scopeProblem(['**'])).toMatch(/whole project/);
    expect(scopeProblem(['*.ts'])).toMatch(/whole project/);
    expect(scopeProblem(['.'])).toMatch(/whole project/);
    expect(scopeProblem(['../other/file.ts'])).toMatch(/inside the project/);
    expect(scopeProblem(['/etc/passwd'])).toMatch(/inside the project/);
    expect(scopeProblem(['C:\\Windows\\win.ini'])).toMatch(/inside the project/);
    expect(scopeProblem(['~/notes.md'])).toMatch(/inside the project/);
  });
});

describe('keeping an agent to its paths', () => {
  it('lets it change a file it was given, a file under a folder it was given, and what a pattern names', () => {
    const scopes = ['src/api', 'docs/api.md', 'tests/**/*.api.test.ts'];
    expect(inScope('src/api/users.ts', scopes)).toBe(true);
    expect(inScope('src/api/deep/down/x.ts', scopes)).toBe(true);
    expect(inScope('docs/api.md', scopes)).toBe(true);
    expect(inScope('tests/unit/users.api.test.ts', scopes)).toBe(true);
    expect(inScope('src/apiary/x.ts', scopes)).toBe(false);
    expect(inScope('docs/api.md.bak', scopes)).toBe(false);
    expect(inScope('tests/unit/users.test.ts', scopes)).toBe(false);
    expect(inScope('src/ui/app.tsx', scopes)).toBe(false);
  });

  it('names what a tool call would change outside them, as paths in the project', () => {
    const root = process.platform === 'win32' ? 'C:\\work\\shop' : '/work/shop';
    const abs = (rel: string): string => (process.platform === 'win32' ? `${root}\\${rel.replace(/\//g, '\\')}` : `${root}/${rel}`);
    expect(outsideScope([abs('src/api/users.ts')], ['src/api/**'], root)).toEqual([]);
    expect(outsideScope([abs('src/api/users.ts'), abs('src/ui/app.tsx')], ['src/api/**'], root)).toEqual(['src/ui/app.tsx']);
    // Outside the project is outside every scope.
    const elsewhere = process.platform === 'win32' ? 'C:\\other\\x.ts' : '/other/x.ts';
    expect(outsideScope([elsewhere], ['src/api/**'], root)).toHaveLength(1);
  });
});
