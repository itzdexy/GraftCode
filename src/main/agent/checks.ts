import fs from 'node:fs';
import path from 'node:path';
import type { ChecksConfig } from '@shared/schemas/config';
import type { CheckReport } from '@shared/schemas/messages';
import type { ShellManager } from '../tools/shell/shellManager';

/** Output kept per command. The end is where a failure explains itself. */
const MAX_OUTPUT = 12_000;

/** How many rounds of "the checks failed, fix them" the agent gets before we accept the failure. */
export const MAX_CHECK_ROUNDS = 2;

export interface CheckRunOptions {
  sessionId: string;
  cwd: string;
  signal: AbortSignal;
  shells: ShellManager;
}

function tail(text: string, max: number): string {
  return text.length > max ? text.slice(-max) : text;
}

/**
 * Runs the project's own checks (a type check, a linter, the tests) after a turn
 * changed files. Every command runs even after one fails: a fix round needs the
 * whole picture, not just the first thing that broke.
 */
export async function runChecks(config: ChecksConfig, round: number, options: CheckRunOptions): Promise<CheckReport> {
  const runs: CheckReport['runs'] = [];
  for (const command of config.commands) {
    if (options.signal.aborted) break;
    const result = await options.shells.run(options.sessionId, command, {
      cwd: options.cwd,
      timeoutMs: config.timeoutSec * 1000,
      signal: options.signal
    });
    const output = tail(result.output, MAX_OUTPUT);
    runs.push({
      command,
      exitCode: result.exitCode,
      output,
      truncated: result.truncated || output.length < result.output.length,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      passed: !result.timedOut && result.exitCode === 0
    });
  }
  return { passed: runs.length > 0 && runs.every((r) => r.passed), runs, round };
}

/** The one line stored with the "check" message, and shown in the transcript. */
export function checksSummary(report: CheckReport): string {
  const failed = report.runs.filter((r) => !r.passed).length;
  const subject = report.runs.length === 1 ? 'check' : 'checks';
  return failed === 0
    ? `Checks passed (${report.runs.length} ${subject}).`
    : `Checks failed (${failed} of ${report.runs.length} ${subject}).`;
}

/** What the agent reads when the checks fail: what ran, and the end of its output. */
export function checksFailurePrompt(report: CheckReport): string {
  const sections = report.runs
    .filter((r) => !r.passed)
    .map((r) => {
      const why = r.timedOut ? 'timed out' : `exited with code ${r.exitCode ?? '?'}`;
      return `$ ${r.command}\n(${why})\n\n${r.output}`;
    });
  return [
    `The project's checks did not pass after your changes:`,
    ...sections,
    '',
    'Fix the cause rather than the symptom: these are this repository\'s own checks, so they are what has to pass. Re-run them yourself if you can, and if a failure is unrelated to your change, say so instead of editing around it.'
  ].join('\n\n');
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** The package manager a JavaScript project uses, from its lockfile. */
function packageManager(root: string): 'npm' | 'pnpm' | 'yarn' | 'bun' {
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(root, 'bun.lockb')) || fs.existsSync(path.join(root, 'bun.lock'))) return 'bun';
  return 'npm';
}

// The scripts worth running after a change, fastest first: types, then lint, then tests.
const SCRIPT_ORDER = ['typecheck', 'type-check', 'check-types', 'tsc', 'lint', 'test'];
// What `npm init` puts in "test" until someone writes real tests.
const PLACEHOLDER_TEST = /no test specified/i;

/**
 * Commands that look right for a project, read from its package.json scripts,
 * Cargo.toml, go.mod and Python config. Only suggestions: nothing runs until
 * the user saves them as the project's checks.
 */
export function suggestChecks(root: string): string[] {
  const out: string[] = [];
  const pkgText = readText(path.join(root, 'package.json'));
  if (pkgText) {
    let scripts: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(pkgText) as { scripts?: unknown };
      if (parsed.scripts && typeof parsed.scripts === 'object') scripts = parsed.scripts as Record<string, unknown>;
    } catch {
      // A package.json that doesn't parse has nothing to suggest.
    }
    const pm = packageManager(root);
    for (const name of SCRIPT_ORDER) {
      const body = scripts[name];
      if (typeof body !== 'string' || body.trim() === '') continue;
      if (name === 'test' && PLACEHOLDER_TEST.test(body)) continue;
      if (name === 'test') out.push(pm === 'bun' ? 'bun run test' : `${pm} test`);
      else out.push(pm === 'npm' ? `npm run ${name}` : `${pm} run ${name}`);
    }
  }
  if (fs.existsSync(path.join(root, 'Cargo.toml'))) out.push('cargo check', 'cargo test');
  if (fs.existsSync(path.join(root, 'go.mod'))) out.push('go vet ./...', 'go test ./...');
  const pyproject = readText(path.join(root, 'pyproject.toml')) ?? '';
  if (pyproject.includes('[tool.ruff') || fs.existsSync(path.join(root, 'ruff.toml')) || fs.existsSync(path.join(root, '.ruff.toml'))) out.push('ruff check .');
  if (pyproject.includes('[tool.mypy') || fs.existsSync(path.join(root, 'mypy.ini'))) out.push('mypy .');
  if (pyproject.includes('[tool.pytest') || fs.existsSync(path.join(root, 'pytest.ini')) || fs.existsSync(path.join(root, 'conftest.py'))) out.push('pytest -q');
  return [...new Set(out)];
}
