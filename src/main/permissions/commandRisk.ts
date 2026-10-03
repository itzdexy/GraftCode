import os from 'node:os';
import path from 'node:path';
import { isInside } from '../tools/paths';
import { splitCommand, stripPrefixes, words } from './commandParse';

export type CommandRisk = 'read-only' | 'low' | 'unknown';

const READ_ONLY_COMMANDS = new Set([
  'ls', 'dir', 'pwd', 'cat', 'type', 'head', 'tail', 'wc', 'echo', 'printf', 'which', 'where', 'whereis', 'file',
  'stat', 'du', 'df', 'tree', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'sort', 'uniq', 'cut', 'diff', 'cmp',
  'date', 'whoami', 'hostname', 'uname', 'basename', 'dirname', 'realpath', 'readlink', 'true', 'false', 'test',
  'get-childitem', 'gci', 'get-content', 'gc', 'get-location', 'gl', 'select-string', 'sls', 'test-path',
  'get-item', 'measure-object', 'get-command', 'resolve-path', 'jq', 'column', 'less', 'more', 'nl', 'od', 'xxd',
  'sha256sum', 'md5sum', 'shasum', 'get-filehash', 'cd', 'set-location', 'get-date', 'get-timezone', 'cal'
]);
const GIT_READ = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'shortlog', 'grep', 'ls-tree', 'cat-file', 'merge-base', 'rev-list', 'reflog', 'whatchanged', 'name-rev', 'for-each-ref']);
// Local git operations only; push/clone/pull talk to remotes and are asked about.
const GIT_LOW = new Set(['add', 'commit', 'stash', 'switch', 'checkout', 'merge', 'rebase', 'restore', 'tag', 'mv', 'rm', 'cherry-pick', 'revert', 'apply', 'init', 'fetch']);
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
// Running project scripts is low risk; installing or executing downloaded packages is not.
const PM_LOW = new Set(['test', 't', 'run', 'run-script', 'build', 'lint', 'format', 'typecheck', 'ls', 'list', 'outdated', 'why', 'start', 'dev']);
const DEV_TOOLS = new Set([
  'tsc', 'vitest', 'jest', 'mocha', 'eslint', 'prettier', 'biome', 'playwright', 'vite', 'webpack', 'rollup', 'esbuild', 'turbo', 'nx',
  'pytest', 'ruff', 'black', 'isort', 'mypy', 'pyright', 'flake8', 'pylint', 'tox', 'nox',
  'go', 'gofmt', 'cargo', 'rustc', 'rustfmt', 'make', 'cmake', 'ninja', 'mvn', 'gradle', 'gradlew',
  'dotnet', 'swift', 'xcodebuild', 'node', 'deno', 'python', 'python3', 'py', 'ruby', 'rake', 'rspec',
  'php', 'phpunit', 'mix', 'elixir', 'java', 'javac', 'kotlinc', 'zig', 'gcc', 'g++', 'clang', 'clang++',
  'mkdir', 'touch', 'cp', 'mv', 'ln', 'sed', 'awk', 'tr', 'tee', 'new-item', 'copy-item', 'move-item', 'set-content', 'add-content', 'out-file'
]);

function commandName(w: string[]): string {
  return (w[0] ?? '').toLowerCase().replace(/\.(exe|cmd|bat)$/, '').split(/[\\/]/).pop() ?? '';
}

function segmentRisk(w: string[]): CommandRisk {
  const name = commandName(w);
  if (name === 'find') return w.some((x) => ['-exec', '-execdir', '-delete', '-ok', '-fprint'].includes(x)) ? 'unknown' : 'read-only';
  if (READ_ONLY_COMMANDS.has(name)) return 'read-only';
  if (name === 'git') {
    const sub = w[1] ?? '';
    if (GIT_READ.has(sub)) return 'read-only';
    if (sub === 'branch' || sub === 'remote' || sub === 'tag') return w.length <= 3 && !w.some((x) => x.startsWith('-') && x !== '-v' && x !== '-a' && x !== '--list') ? 'read-only' : 'low';
    return GIT_LOW.has(sub) ? 'low' : 'unknown';
  }
  if (PACKAGE_MANAGERS.has(name)) {
    const sub = w[1] ?? '';
    if (sub === '--version' || sub === '-v') return 'read-only';
    return PM_LOW.has(sub) ? 'low' : 'unknown';
  }
  if (w.length === 2 && (w[1] === '--version' || w[1] === '-V' || w[1] === 'version')) return 'read-only';
  if (DEV_TOOLS.has(name)) return 'low';
  return 'unknown';
}

/** Least-safe risk across all simple commands; substitutions and heredocs are "unknown". */
export function classifyCommand(command: string): CommandRisk {
  const { segments, complex } = splitCommand(command);
  if (complex || segments.length === 0) return 'unknown';
  let worst: CommandRisk = 'read-only';
  for (const segment of segments) {
    // Output redirection writes files: at least "low".
    const redirects = /(^|[^>&0-9])>{1,2}\s*[^&\s]/.test(segment.replace(/"[^"]*"|'[^']*'/g, ''));
    const risk = segmentRisk(words(stripPrefixes(segment)));
    const effective: CommandRisk = redirects && risk === 'read-only' ? 'low' : risk;
    if (effective === 'unknown') return 'unknown';
    if (effective === 'low') worst = 'low';
  }
  return worst;
}

/**
 * Absolute or home-relative paths mentioned in a command that fall outside
 * the project. Git Bash /c/... paths are understood on Windows.
 */
export function outsidePaths(command: string, projectRoot: string, platform: NodeJS.Platform = process.platform, home = os.homedir()): string[] {
  const out: string[] = [];
  for (const segment of splitCommand(command).segments) {
    for (const raw of words(stripPrefixes(segment)).slice(1)) {
      const word = raw.replace(/^[-\w]+=/, '');
      let candidate: string | null = null;
      if (word === '~' || word.startsWith('~/') || word.startsWith('~\\')) candidate = path.join(home, word.slice(2));
      else if (platform === 'win32' && /^[A-Za-z]:[\\/]/.test(word)) candidate = word;
      else if (platform === 'win32' && /^\/[a-zA-Z]\//.test(word)) candidate = `${word[1]!.toUpperCase()}:\\${word.slice(3)}`;
      else if (platform !== 'win32' && word.startsWith('/')) candidate = word;
      else if (/^\.\.([\\/]|$)/.test(word)) candidate = path.resolve(projectRoot, word);
      if (candidate && /^\/dev\/null$|^nul$/i.test(word)) continue;
      if (candidate && !isInside(projectRoot, candidate, platform)) out.push(word);
    }
  }
  return out;
}
