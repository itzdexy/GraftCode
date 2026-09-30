#!/usr/bin/env node
/**
 * Calibrates type sizes against the reference measurements: renders sample
 * strings in the built app with the bundled fonts at candidate sizes,
 * screenshots them, and reports ink cap heights / widths next to the values
 * in docs/design/measurements.json. Run after `electron-vite build`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';
import { PNG } from 'pngjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const measurements = JSON.parse(fs.readFileSync(path.join(root, 'docs/design/measurements.json'), 'utf8'));
const t = measurements.typography;

// Widths are measured in the references by scripts/measure-reference.mjs-style ink scans.
const samples = [
  { id: 'greeting', family: 'serif', text: 'Good afternoon, dexy', glyph: 'G', sizes: [36, 37, 38, 39], target: { cap: t.greetingCapG, width: t.greetingWidth } },
  { id: 'chat-prose', family: 'serif', text: "Hi! What are you working on? If it's an existing project, tell me where the code lives (or paste", glyph: 'H', sizes: [15, 15.5, 16, 16.5], target: { cap: t.assistantSerifCapH, width: 616 } },
  { id: 'sidebar', family: 'sans', text: 'Building a quality web scraper', glyph: 'B', sizes: [12, 12.5, 13], target: { cap: t.sidebarItemCap, width: 165 } },
  { id: 'nav', family: 'sans', text: 'Projects', glyph: 'P', sizes: [12, 12.5, 13], target: { width: 46 } },
  { id: 'code-prose', family: 'sans', text: 'The existing driver covers the hub, menus, an Airmail ride, and respawn,', glyph: 'T', sizes: [13, 13.5, 14], target: { cap: t.codeProseCapT, width: 422 } },
  { id: 'welcome', family: 'sans', text: 'Welcome back, dexy', glyph: 'W', sizes: [18, 19, 20], target: { cap: t.welcomeCapW, width: 173 } },
  { id: 'description', family: 'sans', text: 'For your toughest challenges', glyph: 'F', sizes: [11, 11.5, 12], target: { width: 158 } },
  { id: 'placeholder-home', family: 'sans', text: 'How can I help you today?', glyph: 'H', sizes: [13, 14, 15], target: { width: 162 } },
  { id: 'placeholder-code', family: 'sans', text: 'Describe a task or ask a question', glyph: 'D', sizes: [13, 13.5, 14], target: { width: 193 } },
  { id: 'header', family: 'sans', text: 'Chats and tasks', glyph: 'C', sizes: [11, 11.5, 12], target: { cap: t.sidebarHeaderCap, width: 82 } }
];

/** Ink bounds, ignoring a 3px frame: the element's fractional edge can pick up page pixels. */
function inkBox(png) {
  const margin = 3;
  let top = -1, bottom = -1, left = png.width, right = -1;
  for (let y = margin; y < png.height - margin; y++) {
    for (let x = margin; x < png.width - margin; x++) {
      const i = (png.width * y + x) << 2;
      if (png.data[i] + png.data[i + 1] + png.data[i + 2] > 3 * 120) {
        if (top < 0) top = y;
        bottom = y;
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
    }
  }
  return top < 0 ? null : { height: bottom - top + 1, width: right - left + 1 };
}

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-cal-'));
const env = { ...process.env, GRAFT_USER_DATA_DIR: userData, GRAFT_HOME: userData };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: [path.join(root, 'out/main/index.js')], env });
const page = await app.firstWindow();
await page.waitForLoadState('domcontentloaded');
await page.evaluate(() => document.fonts.ready);

for (const sample of samples) {
  const rows = [];
  for (const size of sample.sizes) {
    const measure = async (text) => {
      await page.evaluate(
        ({ text, size, family }) => {
          let el = document.getElementById('graft-calibrate');
          if (!el) {
            el = document.createElement('div');
            el.id = 'graft-calibrate';
            el.style.cssText = 'position:fixed;left:20px;top:20px;z-index:99999;background:#000;color:#fff;padding:12px;white-space:nowrap;line-height:1.6';
            document.body.appendChild(el);
          }
          el.style.fontFamily = `var(--g-font-${family})`;
          el.style.fontSize = `${size}px`;
          el.textContent = text;
        },
        { text, size, family: sample.family }
      );
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(document.fonts.ready))))
      );
      const buf = await page.locator('#graft-calibrate').screenshot({ animations: 'disabled' });
      return inkBox(PNG.sync.read(buf));
    };
    const cap = await measure(sample.glyph);
    const full = await measure(sample.text);
    rows.push({ size, cap: cap?.height ?? null, width: full?.width ?? null });
  }
  console.log(`${sample.id} target ${JSON.stringify(sample.target)}`);
  for (const r of rows) console.log(`  ${r.size}px → cap ${r.cap}px, text width ${r.width}px`);
}

await app.close();
fs.rmSync(userData, { recursive: true, force: true });
