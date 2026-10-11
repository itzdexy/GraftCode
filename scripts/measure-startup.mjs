#!/usr/bin/env node
/**
 * Measures how long the built app takes to start and to quit. Run after `electron-vite build`:
 *
 *   node scripts/measure-startup.mjs            five runs of each kind
 *   node scripts/measure-startup.mjs 10         ten
 *
 * Two kinds of start are timed, each on a profile nobody else uses:
 *   new profile    the first start ever: the database is created and migrated
 *   second start   the same profile started again
 *
 * Three moments, in milliseconds from asking the system to start the app:
 *   window      the first window exists
 *   interface   the first screen has been drawn in it
 *   quit        from asking the app to close until its process is gone
 *
 * The numbers include Playwright attaching to the app, which a person starting it does not
 * pay, so they are for comparing two builds on one computer, not for quoting on their own.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'out', 'main', 'index.js');
if (!fs.existsSync(entry)) {
  console.error('out/main/index.js is missing: run `npm run build` first.');
  process.exit(1);
}
const runs = Math.max(1, Number.parseInt(process.argv[2] ?? '5', 10) || 5);
const flags = process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [];

/** One start and one quit on the given profile. */
async function once(userData, graftHome) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && key !== 'ELECTRON_RUN_AS_NODE'));
  Object.assign(env, { GRAFT_USER_DATA_DIR: userData, GRAFT_HOME: graftHome, GRAFT_E2E: '1' });
  const startedAt = performance.now();
  const app = await electron.launch({ args: [...flags, entry], env, cwd: root });
  const window = await app.firstWindow();
  const windowMs = performance.now() - startedAt;
  await window.waitForFunction(() => (document.getElementById('root')?.childElementCount ?? 0) > 0);
  const interfaceMs = performance.now() - startedAt;
  const closingAt = performance.now();
  await app.close();
  return { window: windowMs, interface: interfaceMs, quit: performance.now() - closingAt };
}

function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  const median = sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return { median: Math.round(median), min: Math.round(sorted[0]), max: Math.round(sorted.at(-1)) };
}

const results = { 'new profile': [], 'second start': [] };
for (let run = 0; run < runs; run++) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-measure-data-'));
  const graftHome = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-measure-home-'));
  try {
    results['new profile'].push(await once(userData, graftHome));
    results['second start'].push(await once(userData, graftHome));
  } finally {
    for (const dir of [userData, graftHome]) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
console.log(`Graft ${version}, ${String(runs)} runs of each kind, ${os.platform()} ${os.release()}, ${os.cpus()[0]?.model.trim() ?? 'unknown processor'}, ${String(Math.round(os.totalmem() / 2 ** 30))} GB`);
console.log('kind            moment      median     min     max   (ms)');
for (const [kind, measured] of Object.entries(results)) {
  for (const moment of ['window', 'interface', 'quit']) {
    const s = summary(measured.map((m) => m[moment]));
    console.log(`${kind.padEnd(15)} ${moment.padEnd(10)} ${String(s.median).padStart(7)} ${String(s.min).padStart(7)} ${String(s.max).padStart(7)}`);
  }
}
