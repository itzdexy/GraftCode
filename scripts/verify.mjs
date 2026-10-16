#!/usr/bin/env node
// Runs what a round is checked with on this computer, one step after another and whatever
// the step before did: typecheck, lint, the unit suite, the build and the desktop suite.
// Each step's output goes to out/verify/<step>.log and its exit code to
// out/verify/summary.txt (out/ is emptied neither by a build nor by Playwright).
// The same in a clean Linux container: scripts/e2e-docker.mjs --all.
//
// The desktop suite drives real windows: run nothing else of this project beside it.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'out', 'verify');
const STEPS = [
  ['typecheck', 'npm run typecheck'],
  ['lint', 'npm run lint'],
  ['unit', 'npm test'],
  ['build', 'npm run build'],
  ['e2e', 'npx playwright test']
];

fs.mkdirSync(OUT, { recursive: true });
const summary = [];
for (const [name, command] of STEPS) {
  const started = Date.now();
  const log = fs.openSync(path.join(OUT, `${name}.log`), 'w');
  const result = spawnSync(command, { cwd: ROOT, shell: true, stdio: ['ignore', log, log] });
  fs.closeSync(log);
  const line = `${name}: exit ${result.status ?? `none (${result.signal ?? result.error?.message ?? 'unknown'})`}, ${Math.round((Date.now() - started) / 1000)} s`;
  summary.push(line);
  console.log(line);
  fs.writeFileSync(path.join(OUT, 'summary.txt'), `${summary.join('\n')}\n`);
}
process.exit(summary.every((line) => line.includes(': exit 0,')) ? 0 : 1);
