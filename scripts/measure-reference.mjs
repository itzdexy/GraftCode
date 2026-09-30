#!/usr/bin/env node
/**
 * Samples the reference screenshots in ./reference and writes
 * docs/design/measurements.json. The design tokens in
 * src/renderer/src/styles/tokens.css are authored from this output.
 *
 * Screenshots are Windows ClearType renders at 100% scale, so:
 *  - fills and borders are read as exact pixel colors,
 *  - text colors are estimated from the brightest low-chroma ink pixels,
 *  - type sizes are recorded as cap heights (rows of ink) and line pitches,
 *  - corner radii are fitted to the anti-aliased corner profile.
 *
 * Usage: node scripts/measure-reference.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const refDir = path.join(root, 'reference');
const outFile = path.join(root, 'docs', 'design', 'measurements.json');

const images = new Map();
function img(n) {
  if (!images.has(n)) {
    const file = path.join(refDir, `${String(n).padStart(2, '0')}.png`);
    if (!fs.existsSync(file)) throw new Error(`Missing reference screenshot: ${file}`);
    images.set(n, PNG.sync.read(fs.readFileSync(file)));
  }
  return images.get(n);
}

function px(image, x, y) {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) {
    throw new Error(`Probe (${x},${y}) outside ${image.width}x${image.height}`);
  }
  const i = (image.width * y + x) << 2;
  return [image.data[i], image.data[i + 1], image.data[i + 2]];
}
const hex = ([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
const parse = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const dist = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

/** Exact color at a point. */
const color = (n, x, y) => hex(px(img(n), x, y));

/** Text color: median of the brightest 10% low-chroma ink pixels (robust to ClearType fringes). */
function textColor(n, [x0, y0, x1, y1], bgHex) {
  const image = img(n);
  const bg = parse(bgHex);
  const ink = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = px(image, x, y);
      const chroma = Math.max(...p) - Math.min(...p);
      if (dist(p, bg) > 24 && chroma < 18) ink.push(p);
    }
  }
  if (ink.length === 0) throw new Error(`No text ink in image ${n} at ${[x0, y0, x1, y1]}`);
  ink.sort((a, b) => lum(b) - lum(a));
  const k = Math.max(1, Math.floor(ink.length * 0.1));
  return hex(ink[Math.floor(k / 2)]);
}

/** Saturated ink color (status dots, colored text): brightest 6% of all ink pixels, averaged. */
function inkColor(n, [x0, y0, x1, y1], bgHex) {
  const image = img(n);
  const bg = parse(bgHex);
  const ink = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const p = px(image, x, y);
    if (dist(p, bg) > 24) ink.push(p);
  }
  if (ink.length === 0) throw new Error(`No ink in image ${n} at ${[x0, y0, x1, y1]}`);
  ink.sort((a, b) => lum(b) - lum(a));
  const k = Math.max(1, Math.floor(ink.length * 0.06));
  const sum = [0, 0, 0];
  for (let i = 0; i < k; i++) for (let c = 0; c < 3; c++) sum[c] += ink[i][c];
  return hex(sum.map((v) => Math.round(v / k)));
}

/** Rows (inclusive ranges) that contain ink within a column band. */
function inkRows(n, [x0, y0, x1, y1], bgHex, threshold = 24) {
  const image = img(n);
  const bg = parse(bgHex);
  const segs = [];
  let start = -1;
  for (let y = y0; y <= y1; y++) {
    let ink = false;
    if (y < y1) for (let x = x0; x < x1 && !ink; x++) ink = dist(px(image, x, y), bg) > threshold;
    if (ink && start < 0) start = y;
    if (!ink && start >= 0) { segs.push([start, y - 1]); start = -1; }
  }
  return segs;
}

/** Columns (inclusive ranges) that contain ink within a row band. */
function inkCols(n, [x0, y0, x1, y1], bgHex, threshold = 24) {
  const image = img(n);
  const bg = parse(bgHex);
  const segs = [];
  let start = -1;
  for (let x = x0; x <= x1; x++) {
    let ink = false;
    if (x < x1) for (let y = y0; y < y1 && !ink; y++) ink = dist(px(image, x, y), bg) > threshold;
    if (ink && start < 0) start = x;
    if (!ink && start >= 0) { segs.push([start, x - 1]); start = -1; }
  }
  return segs;
}

/** Extent of a uniformly filled run along a row or column starting from a seed. */
function span(n, sx, sy, axis, tolerance = 3) {
  const image = img(n);
  const seed = px(image, sx, sy);
  let a = axis === 'x' ? sx : sy;
  let b = a;
  const at = (v) => (axis === 'x' ? px(image, v, sy) : px(image, sx, v));
  const limit = axis === 'x' ? image.width : image.height;
  while (a > 0 && dist(at(a - 1), seed) <= tolerance) a--;
  while (b < limit - 1 && dist(at(b + 1), seed) <= tolerance) b++;
  return { from: a, to: b, length: b - a + 1, fill: hex(seed) };
}

/** Corner radius fitted to the top-left corner inset profile of a shape. */
function cornerRadius(n, x0, y0, outsideHex, threshold = 6, maxR = 24) {
  const image = img(n);
  const outside = parse(outsideHex);
  const insets = [];
  for (let d = 0; d < maxR; d++) {
    let x = x0;
    while (x < x0 + maxR + 2 && dist(px(image, x, y0 + d), outside) <= threshold) x++;
    insets.push(x - x0);
  }
  let best = { r: 0, err: Infinity };
  for (let r = 1; r <= maxR; r += 0.5) {
    let err = 0;
    for (let d = 0; d < maxR; d++) {
      const yc = d + 0.5;
      const expected = yc >= r ? 0 : r - Math.sqrt(Math.max(0, r * r - (r - yc) ** 2));
      err += (insets[d] - expected) ** 2;
    }
    if (err < best.err) best = { r, err };
  }
  return best.r;
}

/** Same as cornerRadius, but reads the bottom-left corner upward. */
function cornerRadiusBottom(n, x0, yBottom, outsideHex, threshold = 6, maxR = 16) {
  const image = img(n);
  const outside = parse(outsideHex);
  const insets = [];
  for (let d = 0; d < maxR; d++) {
    let x = x0;
    while (x < x0 + maxR + 2 && dist(px(image, x, yBottom - d), outside) <= threshold) x++;
    insets.push(x - x0);
  }
  let best = { r: 0, err: Infinity };
  for (let r = 1; r <= maxR; r += 0.5) {
    let err = 0;
    for (let d = 0; d < maxR; d++) {
      const yc = d + 0.5;
      const expected = yc >= r ? 0 : r - Math.sqrt(Math.max(0, r * r - (r - yc) ** 2));
      err += (insets[d] - expected) ** 2;
    }
    if (err < best.err) best = { r, err };
  }
  return best.r;
}

const height = ([a, b]) => b - a + 1;
const pitch = (segs) => {
  const tops = segs.map((s) => s[0]);
  const gaps = tops.slice(1).map((t, i) => t - tops[i]);
  return +(gaps.reduce((s, g) => s + g, 0) / gaps.length).toFixed(2);
};

const SIDEBAR = '#111111';
const MAIN = '#151515';
const MENU = '#20201f';

const m = {
  source: 'reference/01.png … reference/12.png (Windows, 100% scale, dark theme)',
  generatedBy: 'scripts/measure-reference.mjs',
  surfaces: {
    sidebar: color(1, 100, 900),
    main: color(1, 600, 800),
    sidebarDivider: color(1, 262, 500),
    navSelected: span(1, 150, 45, 'x').fill,
    composer: color(1, 670, 470),
    composerBorderFocused: color(1, 379, 470),
    composerBorderRest: color(2, 10, 220),
    composerShadow: color(1, 670, 518),
    menu: color(2, 245, 450),
    menuBorder: color(2, 235, 400),
    menuDivider: color(2, 300, 453),
    menuItemHover: color(4, 8, 36),
    modelLabelHover: color(2, 405, 245),
    titlebarToggleTrack: color(1, 230, 10),
    titlebarToggleSelected: color(1, 198, 10),
    titlebarToggleSelectedBorder: color(1, 193, 16),
    composerToggleTrack: color(1, 500, 484),
    composerToggleSelected: color(1, 445, 486),
    composerToggleSelectedBorder: color(1, 445, 482),
    badgeNeutral: color(3, 120, 120),
    badgeWarning: color(3, 100, 208),
    userBubble: color(7, 840, 130),
    sessionRow: color(8, 700, 146),
    chip: color(8, 355, 893),
    chipEdge: color(8, 321, 894),
    banner: color(8, 700, 925),
    bannerIconTile: color(8, 330, 940),
    askCard: color(11, 327, 700),
    askCardBorder: color(11, 321, 660),
    askOption: color(11, 336, 700),
    askCounterBadge: color(11, 336, 664),
    askNumberKeyBorder: color(11, 988, 711),
    askInput: color(11, 500, 851),
    askInputBorder: color(11, 500, 837),
    buttonSecondary: color(11, 930, 895),
    buttonPrimaryDisabled: color(11, 972, 895),
    statusBar: color(11, 600, 940),
    diffPill: color(11, 778, 940),
    createPrButton: color(11, 900, 935),
    panel: color(12, 900, 300),
    panelBorder: color(12, 808, 300),
    inlineCode: color(12, 345, 600),
    inlineCodeBorder: color(12, 342, 600),
    scrollbarThumb: color(8, 256, 300),
    contextRingTrack: color(8, 998, 1014)
  },
  text: {
    selected: textColor(1, [35, 44, 62, 58], '#343434'),
    navLabel: textColor(1, [35, 68, 82, 82], SIDEBAR),
    sidebarItem: textColor(1, [35, 257, 242, 270], SIDEBAR),
    sidebarHeader: textColor(1, [13, 232, 96, 246], SIDEBAR),
    viewAll: textColor(1, [15, 759, 58, 772], SIDEBAR),
    footerName: textColor(1, [35, 1004, 62, 1018], SIDEBAR),
    footerPlan: textColor(1, [66, 1004, 92, 1018], SIDEBAR),
    greeting: textColor(1, [520, 350, 858, 390], MAIN),
    placeholder: textColor(7, [232, 962, 350, 984], MENU),
    modelLabel: textColor(1, [776, 487, 834, 500], MENU),
    effortLabel: textColor(1, [840, 487, 866, 500], MENU),
    menuTitle: textColor(2, [247, 275, 300, 289], MENU),
    menuDescription: textColor(2, [247, 291, 410, 304], MENU),
    assistantProse: textColor(7, [205, 185, 820, 226], MAIN),
    messageActions: textColor(7, [200, 238, 320, 256], MAIN),
    disclaimer: textColor(7, [203, 1005, 580, 1022], MAIN),
    headerIcons: textColor(11, [828, 5, 845, 28], MAIN),
    windowControls: textColor(1, [955, 4, 975, 30], MAIN),
    toolSummary: textColor(12, [314, 70, 500, 86], MAIN),
    panelTitle: textColor(12, [815, 45, 920, 60], '#1a1a19'),
    chipLabel: textColor(8, [345, 895, 372, 908], '#2d2d2d'),
    askQuestion: textColor(11, [365, 656, 735, 672], '#1a1a19'),
    askOptionTitle: textColor(11, [338, 694, 490, 710], '#262625'),
    askOptionDescription: textColor(11, [338, 712, 950, 726], '#262625'),
    askNumberKey: textColor(11, [990, 704, 1004, 718], '#262625'),
    statusBarText: textColor(11, [330, 932, 400, 948], '#212121'),
    timelineTick: inkColor(12, [276, 55, 292, 125], MAIN),
    timelineTickCurrent: inkColor(12, [276, 125, 292, 132], MAIN)
  },
  accents: {
    notificationDotCode: inkColor(1, [241, 7, 248, 14], '#1d1d1d'),
    notificationDotSidebarToggle: color(7, 58, 9),
    selectionCheck: inkColor(2, [475, 370, 495, 388], MENU),
    link: inkColor(8, [855, 8, 925, 26], MAIN),
    statusNeedsInputDot: color(8, 20, 384),
    statusNeedsInputText: inkColor(8, [351, 150, 412, 166], '#212121'),
    statusError: inkColor(8, [12, 432, 30, 448], SIDEBAR),
    warningBadgeText: inkColor(3, [79, 207, 153, 222], '#341d08'),
    counterBadgeText: inkColor(11, [336, 656, 356, 672], '#311a00'),
    diffAdded: inkColor(11, [778, 933, 830, 947], '#383838'),
    diffRemoved: inkColor(11, [835, 933, 888, 947], '#383838'),
    inlineCodeText: inkColor(12, [346, 594, 420, 608], '#212121'),
    contextRingActive: inkColor(12, [745, 1006, 765, 1022], MAIN)
  },
  geometry: {
    windowWidth: img(1).width,
    sidebarWidth: 262,
    sidebarDividerX: 262,
    navSelectedRow: { x: span(1, 150, 45, 'x'), y: span(1, 150, 45, 'y') },
    navRowPitch: pitch(inkRows(1, [30, 64, 120, 210], SIDEBAR)),
    chatListPitch: pitch(inkRows(1, [35, 255, 200, 760], SIDEBAR)),
    hollowBullet: { cols: inkCols(1, [8, 255, 30, 272], SIDEBAR)[0], rows: inkRows(1, [14, 255, 26, 272], SIDEBAR)[0] },
    listTextX: inkCols(1, [30, 257, 60, 270], SIDEBAR)[0][0],
    titlebarIcons: inkCols(1, [0, 4, 190, 30], SIDEBAR),
    titlebarToggle: { x: inkCols(1, [180, 4, 262, 30], SIDEBAR, 6)[0], y: span(1, 230, 10, 'y') },
    windowControlGlyphs: inkCols(1, [940, 4, 1077, 30], MAIN),
    footerDividerY: 991,
    footerAvatar: { cols: inkCols(1, [8, 1000, 30, 1022], SIDEBAR)[0], rows: inkRows(1, [10, 996, 28, 1024], SIDEBAR)[0] },
    homeComposer: { x: [379, 962], y: [422, 515], width: 962 - 379 + 1, height: 515 - 422 + 1 },
    composerToggle: { x: inkCols(1, [410, 482, 540, 483], MENU, 6)[0], y: span(1, 474, 490, 'y') },
    composerToggleSelected: { y: inkRows(1, [440, 481, 450, 507], '#2b2b2a', 6)[0] },
    chatColumnComposer: { x: span(7, 250, 958, 'x') },
    userBubbleSingleLine: { y: span(7, 840, 130, 'y') },
    assistantLinePitch: pitch(inkRows(7, [200, 180, 830, 230], MAIN)),
    messageActionIcons: inkCols(7, [200, 238, 320, 256], MAIN),
    menuModelRowPitch: pitch(inkRows(2, [246, 270, 470, 450], MENU).filter((s, i) => i % 2 === 0)),
    menuPlainRowPitch: pitch(inkRows(4, [283, 26, 390, 258], MENU)),
    effortMenuRowPitch: pitch(inkRows(3, [28, 88, 300, 225], '#20201f')),
    menuDividerInsetX: span(2, 300, 453, 'x').from - 236,
    effortSlider: {
      track: span(9, 150, 102, 'x'),
      trackY: span(9, 150, 110, 'y'),
      knobY: span(9, 40, 110, 'y'),
      tickCols: inkCols(9, [60, 100, 215, 119], '#373736')
    },
    sessionRow: { x: span(8, 700, 146, 'x'), y: span(8, 700, 146, 'y'), nextTop: 180 },
    chip: { x: span(8, 355, 893, 'x'), y: span(8, 378, 900, 'y') },
    banner: { y: span(8, 700, 925, 'y') },
    codeComposer: { y: [965, 998] },
    askCard: { x: [321, 1021], y: [643, 915] },
    askOption: { y: span(11, 336, 700, 'y') },
    askNumberKey: { x: [988, 1003], y: [703, 718] },
    askInput: { y: span(11, 500, 851, 'y') },
    statusBar: { y: span(11, 600, 940, 'y') },
    diffPill: { x: span(11, 800, 931, 'x'), y: span(11, 778, 940, 'y') },
    backgroundPanel: { x: [808, 1070], y: [37, 1024] },
    timelineTicks: inkRows(12, [276, 55, 292, 135], MAIN),
    mascotBox: { cols: inkCols(8, [975, 895, 1025, 922], MAIN)[0], rows: inkRows(8, [975, 890, 1025, 925], MAIN)[0] },
    scrollbarThumbX: span(8, 256, 300, 'x')
  },
  radii: {
    homeComposer: cornerRadius(1, 379, 422, MAIN),
    navSelected: cornerRadius(1, 7, 40, SIDEBAR),
    titlebarToggle: cornerRadius(1, 192, 4, SIDEBAR, 3),
    menu: cornerRadiusBottom(3, 17, 233, SIDEBAR),
    modelLabelHover: cornerRadius(2, 400, 230, MENU, 4),
    sessionRow: cornerRadius(8, 331, 140, MAIN, 4),
    userBubble: cornerRadius(7, 834, 111, MAIN, 4),
    askOption: cornerRadius(11, 332, 687, '#1a1a19', 3)
  },
  typography: {
    note: 'capHeight = rows of ink for a flat-topped capital; linePitch = distance between line tops.',
    sidebarItemCap: height(inkRows(1, [35, 255, 43, 275], SIDEBAR)[0]),
    sidebarHeaderCap: height(inkRows(1, [13, 232, 96, 246], SIDEBAR)[0]),
    greetingCapG: height(inkRows(1, [520, 340, 545, 400], MAIN)[0]),
    greetingXHeight: height(inkRows(1, [549, 340, 566, 400], MAIN)[0]),
    greetingWidth: 858 - 520 + 1,
    assistantSerifCapH: height(inkRows(7, [206, 186, 216, 206], MAIN)[0]),
    codeProseCapT: height(inkRows(12, [313, 98, 321, 122], MAIN)[0]),
    codeProseLinePitch: pitch(inkRows(12, [314, 95, 760, 180], MAIN)),
    welcomeCapW: height(inkRows(8, [346, 40, 364, 80], MAIN)[0]),
    sessionsLabelCap: height(inkRows(8, [328, 110, 390, 135], MAIN)[0])
  }
};

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, `${JSON.stringify(m, null, 2)}\n`);
console.log(`Wrote ${path.relative(root, outFile)}`);
