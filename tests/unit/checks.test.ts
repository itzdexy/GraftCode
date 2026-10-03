import { afterEach, describe, expect, it } from 'vitest';
import { checksFailurePrompt, checksSummary, suggestChecks } from '../../src/main/agent/checks';
import { makeTempDir, removeDir, writeFile } from '../support/tmp';

const dirs: string[] = [];
function project(files: Record<string, string>): string {
  const dir = makeTempDir();
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) writeFile(dir, name, content);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) removeDir(dir);
});

describe('suggestChecks', () => {
  it('suggests the type check, lint and test scripts in that order, with the project’s package manager', () => {
    const scripts = { test: 'vitest run', lint: 'eslint .', typecheck: 'tsc --noEmit', build: 'vite build' };
    expect(suggestChecks(project({ 'package.json': JSON.stringify({ scripts }) }))).toEqual(['npm run typecheck', 'npm run lint', 'npm test']);
    expect(suggestChecks(project({ 'package.json': JSON.stringify({ scripts }), 'pnpm-lock.yaml': '' }))).toEqual(['pnpm run typecheck', 'pnpm run lint', 'pnpm test']);
    expect(suggestChecks(project({ 'package.json': JSON.stringify({ scripts }), 'yarn.lock': '' }))).toEqual(['yarn run typecheck', 'yarn run lint', 'yarn test']);
    // `bun test` is Bun's own runner, not the script.
    expect(suggestChecks(project({ 'package.json': JSON.stringify({ scripts: { test: 'jest' } }), 'bun.lock': '' }))).toEqual(['bun run test']);
  });

  it('skips the placeholder test script npm init writes, and a package.json that does not parse', () => {
    expect(suggestChecks(project({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) }))).toEqual([]);
    expect(suggestChecks(project({ 'package.json': '{ not json' }))).toEqual([]);
  });

  it('suggests the usual checks for Rust, Go and Python projects', () => {
    expect(suggestChecks(project({ 'Cargo.toml': '[package]\nname = "x"\n' }))).toEqual(['cargo check', 'cargo test']);
    expect(suggestChecks(project({ 'go.mod': 'module x\n' }))).toEqual(['go vet ./...', 'go test ./...']);
    expect(suggestChecks(project({ 'pyproject.toml': '[tool.ruff]\nline-length = 100\n[tool.pytest.ini_options]\n' }))).toEqual(['ruff check .', 'pytest -q']);
    expect(suggestChecks(project({ 'README.md': '# nothing to run\n' }))).toEqual([]);
  });
});

describe('check reports', () => {
  const run = (command: string, passed: boolean, output = '') => ({
    command,
    exitCode: passed ? 0 : 1,
    output,
    truncated: false,
    durationMs: 10,
    timedOut: false,
    passed
  });

  it('summarizes a report in one line', () => {
    expect(checksSummary({ passed: true, round: 1, runs: [run('npm test', true)] })).toBe('Checks passed (1 check).');
    expect(checksSummary({ passed: false, round: 1, runs: [run('npm run lint', true), run('npm test', false)] })).toBe('Checks failed (1 of 2 checks).');
  });

  it('hands the agent only the failures, with their output', () => {
    const prompt = checksFailurePrompt({ passed: false, round: 1, runs: [run('npm run lint', true, 'clean'), run('npm test', false, 'expected 2, got 3')] });
    expect(prompt).toContain('$ npm test');
    expect(prompt).toContain('expected 2, got 3');
    expect(prompt).not.toContain('npm run lint');
  });
});
