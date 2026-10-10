// Runs the end-to-end tests in a clean Linux container, from the working tree
// as it is now: tracked files and new ones, without what .gitignore names.
// For a computer where the tests cannot drive Electron directly, and for
// checking on Linux what was only run on Windows or macOS.
//
//   npm run test:e2e:docker                             → every desktop test
//   npm run test:e2e:docker -- tests/e2e/chat.spec.ts   → one file
//   npm run verify:docker                               → typecheck, lint, unit tests, build, every desktop test
//   npm run verify:docker -- tests/e2e/chat.spec.ts     → the same, with one file of desktop tests
//
// Needs Docker, git and tar. What Playwright keeps of a failure (traces and
// screenshots) is copied to test-results/docker/. With --all, each step's
// output is there too (typecheck.log, lint.log, unit.log, build.log, e2e.log)
// and summary.txt has the exit code of each: every step runs whatever the one
// before it did, so one run says all that is wrong.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'test-results', 'docker');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

/** Quotes an argument for bash, so a test title with spaces arrives whole. */
const quote = (arg) => `'${arg.replaceAll("'", "'\\''")}'`;
const args = process.argv.slice(2);
const all = args.includes('--all');
const testArgs = args.filter((arg) => arg !== '--all').map(quote).join(' ');

const setUp = [
  'export DEBIAN_FRONTEND=noninteractive CI=1',
  'apt-get update -qq',
  // Electron's runtime libraries and a virtual display.
  'apt-get install -y -qq --no-install-recommends xvfb xauth libgtk-3-0 libnss3 libasound2 libgbm1 libxss1 libxtst6 libnotify4 libsecret-1-0 libatspi2.0-0 libdrm2 libxkbfile1 libxshmfence1 libgl1 > /dev/null',
  // The tests make repositories and commit in them.
  'git config --global user.email e2e@graft.test',
  'git config --global user.name "Graft E2E"',
  'git config --global init.defaultBranch main',
  'mkdir /src && cd /src && tar xf -',
  'npm ci --no-audit --no-fund'
];

const steps = all
  ? [
      'set -e',
      ...setUp,
      'set +e',
      'npm run typecheck > /out/typecheck.log 2>&1; typecheck=$?',
      'npx eslint . --max-warnings 0 > /out/lint.log 2>&1; lint=$?',
      'npx vitest run > /out/unit.log 2>&1; unit=$?',
      'npm run build > /out/build.log 2>&1; build=$?',
      `xvfb-run -a npx playwright test ${testArgs} > /out/e2e.log 2>&1; e2e=$?`,
      'cp -r test-results/. /out/ 2> /dev/null || true',
      'for step in typecheck lint unit build e2e; do echo "== $step"; tail -n 12 "/out/$step.log"; done',
      'echo "typecheck=$typecheck lint=$lint unit=$unit build=$build e2e=$e2e" | tee /out/summary.txt',
      '[ "$typecheck$lint$unit$build$e2e" = 00000 ]'
    ].join('\n')
  : [
      'set -e',
      ...setUp,
      'npm run build',
      `status=0; xvfb-run -a npx playwright test ${testArgs} || status=$?`,
      'cp -r test-results/. /out/ 2> /dev/null || true',
      'exit $status'
    ].join('\n');

// A file deleted here but not yet committed is still listed by git; tar would stop on it.
const names = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, maxBuffer: 1 << 28 })
  .toString('utf8')
  .split('\0')
  .filter((name) => name !== '' && fs.existsSync(path.join(root, name)));
const source = spawnSync('tar', ['--null', '-T', '-', '-cf', '-'], { cwd: root, input: names.join('\0'), maxBuffer: 1 << 30 });
if (source.error || source.status !== 0) {
  console.error(`Couldn't pack the working tree: ${source.error?.message ?? source.stderr.toString()}`);
  process.exit(1);
}

const run = spawnSync(
  'docker',
  ['run', '--rm', '-i', '--shm-size=2g', '-v', 'graft-e2e-electron-cache:/root/.cache/electron', '-v', 'graft-e2e-npm-cache:/root/.npm', '-v', `${out}:/out`, 'node:24-bookworm', 'bash', '-c', steps],
  { input: source.stdout, stdio: ['pipe', 'inherit', 'inherit'], maxBuffer: 1 << 30 }
);
if (run.error) {
  console.error(`Couldn't run docker: ${run.error.message}`);
  process.exit(1);
}
if (run.status !== 0) console.error(`\nWhat the failed steps left: ${out}`);
process.exit(run.status ?? 1);
