// Shoots Graft's launch film, frame by frame.
//
//   node film/film.mjs                  the whole film            -> out/graft-launch.mp4
//   node film/film.mjs code agents      only those scenes         -> out/scenes/<name>.mp4
//   node film/film.mjs code --sheet     a picture every half second, at 1x, and all of them
//                                       on one sheet               -> .cache/stills/<scene>.jpg
//
// What is on screen is the real renderer (built by film/vite.config.mjs), framed on a stage page
// (film/stage) that carries the camera and the titles. The renderer gets a stand-in for the
// preload bridge (film/app/bridge.js) and scripted agent turns (film/app/turns.js). Every page
// runs on a clock this script steps one frame at a time (film/page/time.js), so each frame is
// drawn at an exact moment however long it takes to draw.
//
// Nothing here listens on a port: pages are served from disk through request interception.
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { scenes } from './scenes.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const video = path.join(here, '..');
const repo = path.join(video, '..');
const OUT = path.join(video, 'out');
const STILLS = path.join(video, '.cache', 'stills');
const ORIGIN = 'http://graft.film';
const SIZE = { width: 1920, height: 1080 };
const FPS = 60;
/** Where each kind of address is read from. */
const ROOTS = [
  ['/stage/', path.join(here, 'stage')],
  ['/app/', path.join(video, '.cache', 'app')],
  ['/fonts/', path.join(repo, 'node_modules', '@fontsource-variable')],
  ['/brand/', path.join(repo, 'src', 'renderer', 'src', 'brand')],
  ['/catalog/', path.join(repo, 'resources', 'catalog')]
];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
const wanted = process.argv.slice(2).filter((a) => !a.startsWith('--'));
/** Looking instead of filming: no video, a picture every SHEET_EVERY frames. */
const sheet = flags.includes('--sheet');
const SHEET_EVERY = FPS / 2;
/** Frames are drawn at twice the size and scaled down, so text edges and slow camera moves stay clean. */
const SCALE = sheet ? 1 : 2;

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function fileFor(url) {
  const pathname = decodeURIComponent(new URL(url).pathname);
  for (const [prefix, dir] of ROOTS) {
    if (!pathname.startsWith(prefix)) continue;
    const target = path.join(dir, pathname.slice(prefix.length));
    return target.startsWith(dir) && fs.existsSync(target) && fs.statSync(target).isFile() ? target : null;
  }
  return null;
}

/** x264 at the film's settings; frames arrive as PNGs on stdin. */
function encoder(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const filter = `scale=${String(SIZE.width)}:${String(SIZE.height)}:flags=lanczos+accurate_rnd+full_chroma_int:out_color_matrix=bt709:out_range=tv,format=yuv420p`;
  const child = spawn(
    process.env.FFMPEG ?? 'ffmpeg',
    ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-', '-vf', filter, '-c:v', 'libx264', '-preset', 'slow', '-crf', '15', '-x264-params', 'aq-mode=3', '-g', String(FPS * 2), '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-movflags', '+faststart', file],
    { stdio: ['pipe', 'inherit', 'inherit'] }
  );
  return {
    file,
    async write(png) {
      if (!child.stdin.write(png)) await once(child.stdin, 'drain');
    },
    async close() {
      child.stdin.end();
      const [code] = await once(child, 'close');
      if (code !== 0) throw new Error(`ffmpeg exited with ${String(code)} while writing ${file}`);
    }
  };
}

/** Lays a scene's pictures out on one sheet, three to a row, in order. */
function contactSheet(name) {
  const rows = Math.ceil(fs.readdirSync(path.join(STILLS, name)).length / 3);
  spawnSync(process.env.FFMPEG ?? 'ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(STILLS, name, '%03d.png'), '-vf', `scale=640:-1,tile=3x${String(rows)}`, '-frames:v', '1', '-q:v', '3', path.join(STILLS, `${name}.jpg`)], { stdio: 'inherit' });
}

/** What a scene directs: the stage, the app in its window, the keyboard and pointer, and time. */
class Shoot {
  constructor(page, cdp, name, sink) {
    this.page = page;
    this.cdp = cdp;
    this.name = name;
    this.sink = sink;
    this.app = null;
    this.frames = 0;
    this.recording = false;
    this.pending = 0;
    this.pointer = { x: 960, y: 540 };
    this.keys = 0;
  }

  /** One frame: move the clock, let the pages catch up, take the picture. */
  async step() {
    await this.page.evaluate((ms) => window.__clock.advance(ms), 1000 / FPS);
    for (let i = 0; this.pending > 0 && i < 400; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    await this.page.evaluate(() => window.__clock.settle());
    if (!this.recording) return;
    if (sheet && this.frames % SHEET_EVERY === 0) {
      const dir = path.join(STILLS, this.name);
      fs.mkdirSync(dir, { recursive: true });
      await this.page.screenshot({ path: path.join(dir, `${String(this.frames / SHEET_EVERY).padStart(3, '0')}.png`), caret: 'initial' });
    }
    if (this.sink) {
      const shot = await this.cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true });
      await this.sink.write(Buffer.from(shot.data, 'base64'));
    }
    this.frames += 1;
  }

  async hold(seconds) {
    for (let i = Math.round(seconds * FPS); i > 0; i--) await this.step();
  }

  /** Steps until `test`, run in the app, is true. */
  async until(test, arg, limit = 30) {
    for (let i = Math.round(limit * FPS); i > 0; i--) {
      if (await this.app.evaluate(test, arg)) return;
      await this.step();
    }
    throw new Error(`${this.name}: gave up waiting for ${String(test)}`);
  }

  /** Everything before this is preparation and is not filmed. */
  record() {
    this.recording = true;
  }

  /** Calls window.stage[method] on the stage page. */
  stage(method, ...args) {
    return this.page.evaluate(([m, a]) => window.stage[m](...a), [method, args]);
  }

  /** Puts the app in the window and waits until it has started. */
  async open(width = 1400, height = 730) {
    await this.stage('open', width, height);
    this.app = this.page.frames().find((f) => new URL(f.url()).pathname === '/app/index.html');
    if (!this.app) throw new Error(`${this.name}: the app did not load`);
    await this.app.evaluate(() => document.fonts.ready);
    await this.until(() => document.querySelector('nav') !== null);
    await this.hold(0.5);
  }

  /** A box of the app for the camera: an element (with room around it), or the box itself. */
  async target(what, room = 0) {
    if (typeof what !== 'string' || what === 'wide') return what;
    const box = await this.stage('box', what);
    if (!box) throw new Error(`${this.name}: nothing matches ${what}`);
    return { x: box.x - room, y: box.y - room, w: box.w + 2 * room, h: box.h + 2 * room };
  }

  async cut(what, room) {
    await this.stage('cut', await this.target(what, room));
  }

  /** Starts a camera move; it plays out over the frames that follow. */
  async move(what, seconds, ease = 'move') {
    await this.stage('move', await this.target(what), seconds * 1000, ease);
  }

  /** Types like a person: a key every frame or two, a breath after punctuation. */
  async type(text, pace = 1) {
    for (const char of text) {
      await this.page.keyboard.type(char);
      this.keys += 1;
      const beat = /[.,]/.test(char) ? 5 : char === ' ' ? 2 : [2, 1, 2, 2, 1, 3][this.keys % 6];
      for (let i = Math.max(1, Math.round(beat * pace)); i > 0; i--) await this.step();
    }
  }

  async press(key) {
    await this.page.keyboard.press(key);
  }

  /** Where the middle of an app element is on the stage, wherever the camera is right now. */
  async middle(locator) {
    const point = await locator.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return [r.x + r.width / 2, r.y + r.height / 2];
    });
    return this.stage('toStage', ...point);
  }

  /** Shows the pointer at a point of the app (in the app's pixels). */
  async showPointer(x, y) {
    this.pointer = await this.stage('toStage', x, y);
    await this.page.mouse.move(this.pointer.x, this.pointer.y);
    await this.app.evaluate(() => window.__pointer.show(true));
  }

  /** Moves the pointer to an app element over `seconds`, following it if the camera moves. */
  async pointTo(locator, seconds = 0.6) {
    const from = { ...this.pointer };
    const frames = Math.max(1, Math.round(seconds * FPS));
    for (let i = 1; i <= frames; i++) {
      const to = await this.middle(locator);
      const t = easeInOut(i / frames);
      this.pointer = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
      await this.page.mouse.move(this.pointer.x, this.pointer.y);
      await this.step();
    }
  }

  /** Scrolls an app element down by `distance` of its pixels over `seconds`, easing in and out evenly. */
  async scroll(locator, distance, seconds) {
    const from = await locator.evaluate((el) => el.scrollTop);
    const frames = Math.max(1, Math.round(seconds * FPS));
    for (let i = 1; i <= frames; i++) {
      await locator.evaluate((el, top) => {
        el.scrollTop = top;
      }, from + (distance * (1 - Math.cos((Math.PI * i) / frames))) / 2);
      await this.step();
    }
  }

  async click() {
    await this.page.mouse.down();
    await this.hold(0.08);
    await this.page.mouse.up();
  }
}

async function shoot(browser, scene, sink) {
  const context = await browser.newContext({ viewport: SIZE, deviceScaleFactor: SCALE, reducedMotion: 'no-preference', colorScheme: 'dark', locale: 'en-US' });
  await context.addInitScript({ path: path.join(here, 'page', 'time.js') });
  // The app's stand-ins only belong in the app's page, not on the stage around it.
  for (const file of ['bridge.js', 'turns.js', 'overlay.js']) {
    await context.addInitScript({ content: `if (location.pathname.startsWith('/app/')) {\n${fs.readFileSync(path.join(here, 'app', file), 'utf8')}\n}` });
  }
  // A scene can put sessions in place before the app starts.
  if (scene.seed) await context.addInitScript({ content: `if (location.pathname.startsWith('/app/')) (${scene.seed.toString()})();` });
  const page = await context.newPage();
  const take = new Shoot(page, await context.newCDPSession(page), scene.name, sink);

  await context.route(`${ORIGIN}/**`, async (route) => {
    take.pending += 1;
    try {
      const file = fileFor(route.request().url());
      if (file) await route.fulfill({ status: 200, contentType: MIME[path.extname(file)] ?? 'application/octet-stream', body: fs.readFileSync(file) });
      else await route.fulfill({ status: 404, body: 'Not found' });
    } finally {
      take.pending -= 1;
    }
  });
  page.on('console', (message) => {
    const text = message.text();
    if (message.type() === 'error' || text.startsWith('[preview]') || text.startsWith('[film]')) console.log(`  ${scene.name} · page ${message.type()}: ${text}`);
  });
  page.on('pageerror', (error) => console.log(`  ${scene.name} · page error: ${error.message}`));

  const started = Date.now();
  await page.goto(`${ORIGIN}/stage/index.html`);
  await page.evaluate(() => window.stage.ready);
  await scene.run(take);
  await context.close();
  console.log(`${scene.name}: ${String(take.frames)} frames, ${(take.frames / FPS).toFixed(2)} s (shot in ${((Date.now() - started) / 1000).toFixed(0)} s)`);
  return take.frames;
}

if (!fs.existsSync(path.join(video, '.cache', 'app', 'index.html'))) {
  console.error('Build the renderer first: npm run app (in video/).');
  process.exit(1);
}
for (const name of wanted) if (!scenes.some((s) => s.name === name)) throw new Error(`No scene named "${name}". Scenes: ${scenes.map((s) => s.name).join(', ')}`);

// Grayscale text edges (LCD fringes shimmer once footage is scaled) and a fixed colour profile.
const browser = await chromium.launch({ args: ['--disable-lcd-text', '--force-color-profile=srgb'] });
try {
  if (wanted.length === 0 && !sheet) {
    const sink = encoder(path.join(OUT, 'graft-launch.mp4'));
    let frames = 0;
    for (const scene of scenes) frames += await shoot(browser, scene, sink);
    await sink.close();
    console.log(`${sink.file}: ${(frames / FPS).toFixed(2)} s`);
  } else {
    for (const scene of scenes.filter((s) => wanted.length === 0 || wanted.includes(s.name))) {
      const sink = sheet ? null : encoder(path.join(OUT, 'scenes', `${scene.name}.mp4`));
      if (sheet) fs.rmSync(path.join(STILLS, scene.name), { recursive: true, force: true });
      await shoot(browser, scene, sink);
      if (sink) await sink.close();
      else contactSheet(scene.name);
    }
  }
} finally {
  await browser.close();
}
