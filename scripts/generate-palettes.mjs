// Writes src/renderer/src/styles/palettes.css: the colour palettes and accent
// colours of Settings → Appearance. Tinted palettes recolour the neutral
// tokens of tokens.css in OKLCH, keeping each token's lightness, so text
// contrast stays what the default palette measures. "Contrast" is written out
// by hand. Run after changing the neutral tokens:
//
//   node scripts/generate-palettes.mjs
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const tokens = fs.readFileSync(path.join(root, 'src/renderer/src/styles/tokens.css'), 'utf8');
const out = path.join(root, 'src/renderer/src/styles/palettes.css');

function block(selector) {
  const start = tokens.indexOf(selector);
  if (start < 0) throw new Error(`No ${selector} block in tokens.css`);
  const body = tokens.slice(tokens.indexOf('{', start) + 1, tokens.indexOf('}', start));
  return new Map([...body.matchAll(/(--g-[\w-]+):\s*(#[0-9a-f]{6})\b/gi)].map((m) => [m[1], m[2].toLowerCase()]));
}

const base = { dark: block(":root[data-theme='dark']"), light: block(":root[data-theme='light']") };

const SURFACES = [
  '--g-bg', '--g-bg-sidebar', '--g-surface', '--g-surface-raised', '--g-surface-sunken', '--g-surface-inset', '--g-surface-control',
  '--g-surface-strong', '--g-hover', '--g-sidebar-hover', '--g-selected', '--g-segment-track', '--g-segment-thumb', '--g-toggle-track',
  '--g-toggle-thumb', '--g-badge', '--g-input', '--g-button-secondary', '--g-button-secondary-hover', '--g-button-ghost',
  '--g-code-inline-bg', '--g-code-block-bg', '--g-mark-bg', '--g-button-primary-text'
];
const BORDERS = [
  '--g-segment-thumb-border', '--g-toggle-thumb-border', '--g-input-border', '--g-border-subtle', '--g-border', '--g-border-strong',
  '--g-border-card', '--g-border-panel', '--g-divider', '--g-key-border', '--g-chip-edge', '--g-code-inline-border', '--g-timeline-tick',
  '--g-scrollbar-thumb', '--g-scrollbar-thumb-hover', '--g-button-primary-disabled'
];
const TEXT = [
  '--g-text-strong', '--g-text', '--g-text-secondary', '--g-text-tertiary', '--g-text-muted', '--g-text-faint', '--g-text-placeholder',
  '--g-icon', '--g-icon-strong', '--g-icon-muted', '--g-timeline-tick-current', '--g-button-primary', '--g-button-primary-hover',
  '--g-button-primary-disabled-text', '--g-switch-thumb'
];

/** Hue (degrees) and chroma per role for each tinted palette, per theme. */
const TINTED = {
  midnight: {
    label: 'deep blue',
    dark: { hue: 262, surface: 0.03, border: 0.03, text: 0.012, lift: -0.012 },
    light: { hue: 255, surface: 0.011, border: 0.016, text: 0.022, lift: 0 }
  },
  slate: {
    label: 'cool grey',
    dark: { hue: 245, surface: 0.012, border: 0.014, text: 0.008, lift: 0 },
    light: { hue: 245, surface: 0.007, border: 0.012, text: 0.014, lift: 0 }
  },
  grove: {
    label: 'green',
    dark: { hue: 158, surface: 0.017, border: 0.018, text: 0.01, lift: 0 },
    light: { hue: 150, surface: 0.011, border: 0.016, text: 0.016, lift: 0 }
  },
  dune: {
    label: 'warm sand',
    dark: { hue: 68, surface: 0.02, border: 0.02, text: 0.016, lift: 0 },
    light: { hue: 80, surface: 0.019, border: 0.022, text: 0.018, lift: -0.006 }
  }
};

const CONTRAST = {
  dark: {
    '--g-bg': '#000000', '--g-bg-sidebar': '#000000', '--g-surface': '#0f0f0f', '--g-surface-raised': '#141414', '--g-surface-sunken': '#0a0a0a',
    '--g-surface-inset': '#1a1a1a', '--g-surface-control': '#222222', '--g-surface-strong': '#333333', '--g-hover': '#262626',
    '--g-sidebar-hover': '#1a1a1a', '--g-selected': '#2e2e2e', '--g-segment-track': '#141414', '--g-segment-thumb': '#2e2e2e',
    '--g-segment-thumb-border': '#8a8a8a', '--g-toggle-track': '#1f1f1f', '--g-toggle-thumb': '#3a3a3a', '--g-toggle-thumb-border': '#8a8a8a',
    '--g-badge': '#222222', '--g-input': '#0f0f0f', '--g-input-border': '#8a8a8a', '--g-button-primary': '#ffffff', '--g-button-primary-text': '#000000',
    '--g-button-primary-hover': '#e6e6e6', '--g-button-secondary': '#262626', '--g-button-secondary-hover': '#333333', '--g-button-ghost': '#1a1a1a',
    '--g-border-subtle': '#4d4d4d', '--g-border': '#6e6e6e', '--g-border-strong': '#a6a6a6', '--g-border-card': '#6e6e6e',
    '--g-border-panel': '#4d4d4d', '--g-divider': '#5c5c5c', '--g-key-border': '#8a8a8a', '--g-chip-edge': '#4d4d4d',
    '--g-text-strong': '#ffffff', '--g-text': '#ffffff', '--g-text-secondary': '#e6e6e6', '--g-text-tertiary': '#e0e0e0',
    '--g-text-muted': '#c2c2c2', '--g-text-faint': '#b3b3b3', '--g-text-placeholder': '#b3b3b3', '--g-icon': '#e6e6e6',
    '--g-icon-strong': '#ffffff', '--g-icon-muted': '#b3b3b3', '--g-code-inline-bg': '#141414', '--g-code-inline-border': '#6e6e6e',
    '--g-code-block-bg': '#0a0a0a', '--g-mark-bg': '#262626', '--g-scrollbar-thumb': '#8a8a8a', '--g-scrollbar-thumb-hover': '#a6a6a6'
  },
  light: {
    '--g-bg': '#ffffff', '--g-bg-sidebar': '#f5f5f5', '--g-surface': '#ffffff', '--g-surface-raised': '#f5f5f5', '--g-surface-sunken': '#f0f0f0',
    '--g-surface-inset': '#ebebeb', '--g-surface-control': '#e6e6e6', '--g-surface-strong': '#d6d6d6', '--g-hover': '#e6e6e6',
    '--g-sidebar-hover': '#e6e6e6', '--g-selected': '#d9d9d9', '--g-segment-track': '#ebebeb', '--g-segment-thumb': '#ffffff',
    '--g-segment-thumb-border': '#595959', '--g-toggle-track': '#ebebeb', '--g-toggle-thumb': '#ffffff', '--g-toggle-thumb-border': '#595959',
    '--g-badge': '#e6e6e6', '--g-input': '#ffffff', '--g-input-border': '#595959', '--g-button-primary': '#000000', '--g-button-primary-text': '#ffffff',
    '--g-button-primary-hover': '#262626', '--g-button-secondary': '#e6e6e6', '--g-button-secondary-hover': '#d6d6d6', '--g-button-ghost': '#f0f0f0',
    '--g-border-subtle': '#a6a6a6', '--g-border': '#808080', '--g-border-strong': '#4d4d4d', '--g-border-card': '#808080',
    '--g-border-panel': '#a6a6a6', '--g-divider': '#a6a6a6', '--g-key-border': '#595959', '--g-chip-edge': '#a6a6a6',
    '--g-text-strong': '#000000', '--g-text': '#000000', '--g-text-secondary': '#1a1a1a', '--g-text-tertiary': '#1f1f1f',
    '--g-text-muted': '#3d3d3d', '--g-text-faint': '#474747', '--g-text-placeholder': '#474747', '--g-icon': '#1a1a1a',
    '--g-icon-strong': '#000000', '--g-icon-muted': '#4d4d4d', '--g-code-inline-bg': '#f0f0f0', '--g-code-inline-border': '#808080',
    '--g-code-block-bg': '#f5f5f5', '--g-mark-bg': '#ffffff', '--g-scrollbar-thumb': '#808080', '--g-scrollbar-thumb-hover': '#595959'
  }
};

/** Accent colours: [accent, accent-strong, accent-dim]. Light values are WCAG AA as text on the light surfaces. */
const ACCENTS = {
  ocean: { dark: ['#5aa2f0', '#7db6f5', '#1f3d5f'], light: ['#1f6fd1', '#185db0', '#d3e4f8'] },
  iris: { dark: ['#a58cf0', '#bba6f5', '#3d3266'], light: ['#6b4fd1', '#5a40b8', '#e2dbf8'] },
  rose: { dark: ['#ef7aa6', '#f497ba', '#5c2a3d'], light: ['#c23a6e', '#a82f5e', '#f8d9e5'] },
  gold: { dark: ['#e8b84a', '#f0c96c', '#5c4614'], light: ['#8f6400', '#7a5500', '#f6e7c2'] },
  teal: { dark: ['#4fc1b4', '#6fd3c7', '#1d4d48'], light: ['#0f7f73', '#0b6b61', '#cdebe7'] },
  mono: { dark: ['#d8d7d2', '#f0efec', '#3a3a39'], light: ['#3d3c38', '#1f1e1d', '#e2e1db'] }
};

// sRGB <-> OKLab (Björn Ottosson's matrices).
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function hexToOklch(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => toLinear(v / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(a, bb), h: (Math.atan2(bb, a) * 180) / Math.PI };
}

function oklchToRgb(L, C, h) {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  ].map(fromLinear);
}

/** The colour at this lightness and hue, with as much of the chroma as fits in sRGB. */
function oklchToHex(L, C, h) {
  let chroma = C;
  let rgb = oklchToRgb(L, chroma, h);
  while (rgb.some((v) => v < 0 || v > 1) && chroma > 0) {
    chroma = Math.max(0, chroma - 0.001);
    rgb = oklchToRgb(L, chroma, h);
  }
  return `#${rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')}`;
}

function tint(theme, spec) {
  const values = {};
  const recolor = (names, chroma, lift) => {
    for (const name of names) {
      const hex = base[theme].get(name);
      if (!hex) throw new Error(`tokens.css has no ${name} in the ${theme} theme`);
      const { L } = hexToOklch(hex);
      values[name] = oklchToHex(Math.min(1, Math.max(0, L + lift)), chroma, spec.hue);
    }
  };
  recolor(SURFACES, spec.surface, spec.lift);
  recolor(BORDERS, spec.border, spec.lift);
  recolor(TEXT, spec.text, 0);
  return values;
}

function rules(selector, values) {
  return `${selector} {\n${Object.entries(values)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n')}\n}`;
}

const DARK = ":not([data-theme='light'])";
const LIGHT = "[data-theme='light']";

/**
 * The root selector for a palette or accent, plus a preview selector: any
 * element with data-<kind>-preview takes those colours for its own subtree,
 * so Settings can draw each palette with the real tokens.
 */
function selectors(kind, id, theme) {
  const themed = theme === 'dark' ? DARK : LIGHT;
  const preview = `:root${themed} [data-${kind}-preview='${id}']`;
  return id === null ? preview : `:root[data-${kind}='${id}']${themed},\n${preview}`;
}

/** The default palette's own values, for previews drawn while another palette is on. */
function defaults(theme) {
  return Object.fromEntries([...SURFACES, ...BORDERS, ...TEXT].map((name) => [name, base[theme].get(name)]));
}

const parts = [
  '/*',
  ' * Colour palettes and accent colours (Settings → Appearance), applied as',
  ' * data-palette and data-accent on the root element. Generated by',
  ' * scripts/generate-palettes.mjs from the neutral tokens in tokens.css;',
  ' * edit the script, not this file.',
  ' */'
];
parts.push('\n/* graft: the default palette, for previews only (the root uses tokens.css) */');
for (const theme of ['dark', 'light']) parts.push(rules(selectors('palette', null, theme).replace("'null'", "'graft'"), defaults(theme)));
for (const [id, palette] of Object.entries(TINTED)) {
  parts.push(`\n/* ${id}: ${palette.label} */`);
  parts.push(rules(selectors('palette', id, 'dark'), tint('dark', palette.dark)));
  parts.push(rules(selectors('palette', id, 'light'), tint('light', palette.light)));
}
parts.push('\n/* contrast: black and white with strong borders */');
parts.push(rules(selectors('palette', 'contrast', 'dark'), CONTRAST.dark));
parts.push(rules(selectors('palette', 'contrast', 'light'), CONTRAST.light));
const leaf = { dark: ['--g-accent', '--g-accent-strong', '--g-accent-dim'].map((n) => base.dark.get(n)), light: ['--g-accent', '--g-accent-strong', '--g-accent-dim'].map((n) => base.light.get(n)) };
for (const [id, accent] of [['leaf', leaf], ...Object.entries(ACCENTS)]) {
  parts.push(`\n/* accent: ${id}${id === 'leaf' ? ' (the default, for previews only)' : ''} */`);
  for (const theme of ['dark', 'light']) {
    const [main, strong, dim] = accent[theme];
    const selector = id === 'leaf' ? selectors('accent', null, theme).replace("'null'", "'leaf'") : selectors('accent', id, theme);
    parts.push(rules(selector, { '--g-accent': main, '--g-accent-strong': strong, '--g-accent-dim': dim }));
  }
}
fs.writeFileSync(out, `${parts.join('\n')}\n`);
console.log(`Wrote ${path.relative(root, out)}`);
