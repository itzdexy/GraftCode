/**
 * Scripts the Browser panel runs inside pages. They run in an isolated world:
 * they share the page's DOM but none of its JavaScript, so the page can't see,
 * call or tamper with them. State they keep (the element references from the
 * last snapshot) lives in that world and goes away with the page.
 */

/** Isolated world id for Graft's page scripts (any number that pages can't pick). */
export const GRAFT_WORLD = 7311;

/** Helpers every script gets: a CSS selector, a label and a visibility test for an element. */
const HELPERS = `
const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\\\' + c));
const selectorOf = (el) => {
  if (el.id) return '#' + esc(el.id);
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node !== document.documentElement && parts.length < 5) {
    const testId = node.getAttribute('data-testid');
    if (testId) { parts.unshift(node.tagName.toLowerCase() + '[data-testid="' + testId.replace(/"/g, '\\\\"') + '"]'); break; }
    if (node.id) { parts.unshift('#' + esc(node.id)); break; }
    let part = node.tagName.toLowerCase();
    const classes = [...node.classList].filter((c) => !/^(css|sc|jsx|emotion)-/.test(c) && !c.startsWith('_') && !(/\\d/.test(c) && c.length >= 5)).slice(0, 2);
    if (classes.length > 0) part += '.' + classes.map(esc).join('.');
    const parent = node.parentElement;
    if (parent) {
      const same = [...parent.children].filter((c) => c.tagName === node.tagName);
      if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
    }
    parts.unshift(part);
    node = parent;
  }
  return parts.join(' > ');
};
const labelOf = (el) => (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
`;

/**
 * Runs a script body in its own function with the helpers. Each run needs its
 * own scope: the isolated world outlives the run, so top-level declarations
 * would clash with the previous script's.
 */
function scoped(body: string, arg: unknown = null): string {
  return `((arg) => {${HELPERS}\n${body}\n})(${JSON.stringify(arg)})`;
}

/** Picks an element with the mouse: resolves with what was clicked, or null on Escape. */
export const PICK_ELEMENT = scoped(`
return new Promise((resolve) => {
  if (window.__graftPickDone) window.__graftPickDone(null);
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #5b9a45;background:rgba(91,154,69,.14);border-radius:3px;display:none;box-sizing:border-box';
  const tag = document.createElement('div');
  tag.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#20281d;color:#f3f7f0;padding:1px 6px;border-radius:3px;display:none;max-width:70vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
  document.documentElement.append(box, tag);
  let current = null;
  const move = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === box || el === tag) return;
    current = el;
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    tag.textContent = selectorOf(el) + '  ' + Math.round(r.width) + '×' + Math.round(r.height);
    Object.assign(tag.style, { display: 'block', left: Math.max(0, r.left) + 'px', top: (r.top > 24 ? r.top - 22 : r.bottom + 4) + 'px' });
  };
  const swallow = (e) => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };
  const finish = (value) => {
    window.removeEventListener('mousemove', move, true);
    window.removeEventListener('pointerdown', swallow, true);
    window.removeEventListener('mousedown', swallow, true);
    window.removeEventListener('mouseup', swallow, true);
    window.removeEventListener('click', click, true);
    window.removeEventListener('keydown', key, true);
    box.remove();
    tag.remove();
    window.__graftPickDone = null;
    resolve(value);
  };
  const click = (e) => {
    swallow(e);
    const el = current || document.elementFromPoint(e.clientX, e.clientY);
    if (!el) return finish(null);
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    finish({
      selector: selectorOf(el),
      html: el.outerHTML.slice(0, 6000),
      text: (el.innerText || '').trim().slice(0, 1500),
      size: { width: Math.round(r.width), height: Math.round(r.height) },
      rect: { x: r.left, y: r.top, width: r.width, height: r.height },
      styles: { color: style.color, background: style.backgroundColor, font: style.fontSize + ' ' + style.fontFamily.split(',')[0], margin: style.margin, padding: style.padding, display: style.display }
    });
  };
  const key = (e) => { if (e.key === 'Escape') { swallow(e); finish(null); } };
  window.__graftPickDone = finish;
  window.addEventListener('mousemove', move, true);
  window.addEventListener('pointerdown', swallow, true);
  window.addEventListener('mousedown', swallow, true);
  window.addEventListener('mouseup', swallow, true);
  window.addEventListener('click', click, true);
  window.addEventListener('keydown', key, true);
});`);

export const CANCEL_PICK = 'if (window.__graftPickDone) window.__graftPickDone(null); true';

/**
 * What the agent reads of a page: its text, and the elements it can act on,
 * numbered. The numbers stay valid until the next snapshot or navigation.
 */
export const SNAPSHOT = scoped(`
const refs = [];
const items = [];
const query = 'a[href], button, input:not([type=hidden]), textarea, select, summary, [role=button], [role=link], [role=tab], [role=checkbox], [role=radio], [role=switch], [role=menuitem], [role=option], [contenteditable=""], [contenteditable=true]';
for (const el of document.querySelectorAll(query)) {
  if (!visible(el)) continue;
  refs.push(el);
  const tagName = el.tagName.toLowerCase();
  const role = el.getAttribute('role') || (tagName === 'a' ? 'link' : tagName === 'input' ? 'input[' + (el.type || 'text') + ']' : tagName);
  const item = { ref: refs.length, role, label: labelOf(el), selector: selectorOf(el) };
  if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') item.value = String(el.value || '').slice(0, 80);
  if (el.type === 'checkbox' || el.type === 'radio') item.checked = el.checked;
  if (el.disabled) item.disabled = true;
  items.push(item);
  if (refs.length >= 150) break;
}
window.__graftRefs = refs;
const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim();
return { title: document.title, url: location.href, text: text.slice(0, 8000), truncated: text.length > 8000, items };`);

/**
 * The facts the page check judges (pageCheck.ts, PageFacts): each text with its
 * colour and what is behind it, the pictures, the controls with their names,
 * the headings, and what reaches past the right edge. It reads the page and
 * changes nothing in it.
 *
 * A text's contrast is only worked out where it can be: with a picture or a
 * gradient behind it, or while it is faded, it is marked unsure and left to
 * the eye. "Behind it" is its ancestors up to the first opaque one, and any
 * picture elsewhere in the page that its middle lies over, unless the text
 * sits on a coloured box of its own inside that picture.
 */
export const PAGE_FACTS = scoped(`
const MAX_TEXTS = 600, MAX_IMAGES = 300, MAX_CONTROLS = 400, MAX_HEADINGS = 200, MAX_MEDIA = 400, MAX_ELEMENTS = 6000;
const root = document.documentElement;
const facts = {
  url: location.href, title: document.title || '', lang: (root.getAttribute('lang') || '').trim(),
  viewportMeta: !!document.querySelector('meta[name="viewport"]'),
  width: root.clientWidth, scrollWidth: root.scrollWidth,
  texts: [], images: [], controls: [], headings: [], wide: [], partial: false
};
if (!document.body) return facts;
const squash = (s) => String(s || '').trim().replace(/\\s+/g, ' ');
const pageX = window.scrollX || 0, pageY = window.scrollY || 0;
const boxOf = (el) => { const r = el.getBoundingClientRect(); return { left: r.left + pageX, top: r.top + pageY, right: r.right + pageX, bottom: r.bottom + pageY, width: r.width, height: r.height }; };

// A colour as red, green, blue and how opaque; null when it cannot be read.
const colours = new Map();
let pen = null;
const rgba = (css) => {
  if (colours.has(css)) return colours.get(css);
  let value = null;
  const m = /^rgba?\\(\\s*([\\d.]+)[,\\s]+([\\d.]+)[,\\s]+([\\d.]+)(?:\\s*[,/]\\s*([\\d.]+%?))?\\s*\\)$/.exec(css || '');
  if (m) {
    value = [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4])];
  } else if (css === 'transparent') {
    value = [0, 0, 0, 0];
  } else {
    // Any other notation (oklch, color-mix, a wide gamut): a canvas turns it into sRGB.
    try {
      if (!pen) { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; pen = canvas.getContext('2d', { willReadFrequently: true }); }
      if (pen) {
        pen.fillStyle = '#010203';
        pen.fillStyle = css;
        // A notation the canvas cannot read leaves the colour that was set before it.
        if (pen.fillStyle !== '#010203') {
          pen.clearRect(0, 0, 1, 1);
          pen.fillRect(0, 0, 1, 1);
          const d = pen.getImageData(0, 0, 1, 1).data;
          value = [d[0], d[1], d[2], Math.round(d[3] / 255 * 1000) / 1000];
        }
      }
    } catch (e) { value = null; }
  }
  colours.set(css, value);
  return value;
};

// What an element puts behind its content: a colour, or a picture (its own or one a ::before or ::after draws).
const layers = new Map();
const drawn = (style) => !!style && !!style.backgroundImage && style.backgroundImage !== 'none';
const layerOf = (node) => {
  let layer = layers.get(node);
  if (layer) return layer;
  const style = getComputedStyle(node);
  let image = drawn(style);
  if (!image) { try { image = drawn(getComputedStyle(node, '::before')) || drawn(getComputedStyle(node, '::after')); } catch (e) { image = false; } }
  layer = { color: rgba(style.backgroundColor), image, faded: !(parseFloat(style.opacity) >= 0.999) };
  layers.set(node, layer);
  return layer;
};

// One pass over the elements: where the pictures are, and what reaches past the right edge.
const media = [];
const sticks = new Map();
let scanned = 0;
for (const el of document.body.querySelectorAll('*')) {
  if (++scanned > MAX_ELEMENTS) { facts.partial = true; break; }
  const box = boxOf(el);
  if (box.width <= 0 || box.height <= 0) continue;
  const tag = el.tagName.toUpperCase();
  let picture = tag === 'IMG' || tag === 'VIDEO' || tag === 'CANVAS' || tag === 'IFRAME' || tag === 'PICTURE' || tag === 'OBJECT' || tag === 'EMBED' || tag === 'SVG';
  if (!picture) picture = drawn(getComputedStyle(el));
  if (picture && media.length < MAX_MEDIA) media.push({ el, box });
  if (box.right > facts.width + 1 && box.left < facts.width) sticks.set(el, box.right);
}
// The outermost of what sticks out: what is inside it sticks out because it does.
facts.wide = [...sticks].filter(([el]) => !sticks.has(el.parentElement) && visible(el))
  .sort((a, b) => b[1] - a[1]).slice(0, 5)
  .map(([el, right]) => ({ selector: selectorOf(el), label: labelOf(el), right: Math.round(right) }));

// Texts: every element that holds words of its own.
const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
const taken = new Set();
const NOT_SHOWN = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|OPTION|TEXTAREA|TITLE)$/;
for (let node = walker.nextNode(); node; node = walker.nextNode()) {
  if (!/\\S/.test(node.nodeValue || '')) continue;
  const el = node.parentElement;
  if (!el || taken.has(el)) continue;
  taken.add(el);
  if (NOT_SHOWN.test(el.tagName) || el.namespaceURI !== 'http://www.w3.org/1999/xhtml' || !visible(el)) continue;
  if (el.closest('[disabled], [aria-disabled="true"]')) continue;
  if (facts.texts.length >= MAX_TEXTS) { facts.partial = true; break; }
  const style = getComputedStyle(el);
  const color = rgba(style.webkitTextFillColor || style.color);
  const backgrounds = [];
  let unsure = !color || String(style.webkitBackgroundClip || style.backgroundClip || '').includes('text');
  let ground = null;
  for (let up = el; up && up.nodeType === 1; up = up.parentElement) {
    const layer = layerOf(up);
    if (layer.faded) unsure = true;
    if (ground) continue;
    if (layer.image || !layer.color) { unsure = true; break; }
    if (layer.color[3] > 0) backgrounds.push(layer.color);
    if (layer.color[3] >= 0.999) ground = up;
  }
  if (!unsure) {
    const box = boxOf(el);
    const x = (box.left + box.right) / 2, y = (box.top + box.bottom) / 2;
    const card = ground ? boxOf(ground) : null;
    for (const m of media) {
      if (x < m.box.left || x > m.box.right || y < m.box.top || y > m.box.bottom) continue;
      if (m.el === el || m.el.contains(el) || el.contains(m.el)) continue;
      // Words on a coloured box that lies within the picture are on top of it; any others may have it behind them.
      if (card && card.left >= m.box.left - 1 && card.right <= m.box.right + 1 && card.top >= m.box.top - 1 && card.bottom <= m.box.bottom + 1) continue;
      unsure = true;
      break;
    }
  }
  const own = squash([...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join(' ')).slice(0, 60);
  facts.texts.push({ selector: selectorOf(el), text: own, color: color || [0, 0, 0, 1], backgrounds, unsure, size: parseFloat(style.fontSize) || 16, bold: (parseInt(style.fontWeight, 10) || 400) >= 700 });
}

// Pictures: an alt that is missing is a finding, one that is empty says "decoration".
for (const img of document.images) {
  const style = getComputedStyle(img);
  if (style.display === 'none' || style.visibility === 'hidden') continue;
  if (facts.images.length >= MAX_IMAGES) { facts.partial = true; break; }
  const src = img.currentSrc || img.getAttribute('src') || '';
  const role = (img.getAttribute('role') || '').toLowerCase();
  const aside = role === 'presentation' || role === 'none' || !!img.closest('[aria-hidden="true"]');
  const named = squash(img.getAttribute('aria-label')) || img.hasAttribute('aria-labelledby');
  facts.images.push({
    selector: selectorOf(img),
    alt: img.hasAttribute('alt') ? img.getAttribute('alt') : aside ? '' : named ? String(named) : null,
    label: src.startsWith('data:') ? 'inline picture' : (src.split(/[?#]/)[0].split('/').pop() || 'picture').slice(0, 60),
    broken: src !== '' && img.complete && img.naturalWidth === 0
  });
}
for (const el of document.querySelectorAll('[role="img"]')) {
  if (el.tagName === 'IMG' || !visible(el) || facts.images.length >= MAX_IMAGES) continue;
  const named = squash(el.getAttribute('aria-label')) || el.hasAttribute('aria-labelledby') || !!el.querySelector('title');
  facts.images.push({ selector: selectorOf(el), alt: named ? String(named) : null, label: el.tagName.toLowerCase(), broken: false });
}

// Controls: what each is called, where the name comes from, and the room it takes.
const said = (node) => squash(node.innerText || node.textContent);
const nameOf = (el, tag, type) => {
  const byIds = (el.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean).map((id) => { const t = document.getElementById(id); return t ? said(t) : ''; }).join(' ').trim();
  if (byIds) return [byIds, 'label'];
  const aria = squash(el.getAttribute('aria-label'));
  if (aria) return [aria, 'label'];
  if (tag === 'input' || tag === 'select' || tag === 'textarea') {
    if (tag === 'input' && (type === 'submit' || type === 'reset' || type === 'button')) {
      const value = squash(el.value) || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '');
      if (value) return [value, 'content'];
    }
    if (tag === 'input' && type === 'image' && squash(el.getAttribute('alt'))) return [squash(el.getAttribute('alt')), 'content'];
    const labels = el.labels ? [...el.labels].map(said).join(' ').trim() : '';
    if (labels) return [labels, 'label'];
  } else {
    const content = said(el);
    if (content) return [content, 'content'];
    const inner = el.querySelector('img[alt]:not([alt=""]), [aria-label]:not([aria-label=""])');
    const innerName = inner ? squash(inner.getAttribute('alt') || inner.getAttribute('aria-label')) : '';
    if (innerName) return [innerName, 'content'];
    const drawing = el.querySelector('svg title');
    if (drawing && squash(drawing.textContent)) return [squash(drawing.textContent), 'content'];
  }
  const title = squash(el.getAttribute('title'));
  if (title) return [title, 'title'];
  const placeholder = squash(el.getAttribute('placeholder'));
  if (placeholder) return [placeholder, 'placeholder'];
  return ['', 'none'];
};
const CONTROLS = 'a[href], button, input:not([type="hidden"]), textarea, select, summary, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="menuitem"]';
for (const el of document.querySelectorAll(CONTROLS)) {
  if (!visible(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
  if (facts.controls.length >= MAX_CONTROLS) { facts.partial = true; break; }
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') || '').toLowerCase();
  const role = (el.getAttribute('role') || '').toLowerCase();
  const kind = role || (tag === 'a' ? 'link' : tag === 'summary' ? 'button' : tag !== 'input' ? tag
    : ['button', 'submit', 'reset', 'image'].includes(type) ? 'button' : type === 'checkbox' || type === 'radio' ? type : 'input[' + (type || 'text') + ']');
  const [name, from] = nameOf(el, tag, type);
  let box = boxOf(el);
  // A tick box is hit through its label too: the two are one target.
  if ((type === 'checkbox' || type === 'radio') && el.labels) {
    for (const label of el.labels) {
      const b = boxOf(label);
      if (b.width > 0 && b.height > 0) box = { left: Math.min(box.left, b.left), top: Math.min(box.top, b.top), right: Math.max(box.right, b.right), bottom: Math.max(box.bottom, b.bottom) };
    }
  }
  const inline = tag === 'a' && getComputedStyle(el).display === 'inline' && !!el.parentElement && [...el.parentElement.childNodes].some((n) => n.nodeType === 3 && /\\S/.test(n.nodeValue || ''));
  facts.controls.push({ selector: selectorOf(el), kind, name: String(name).slice(0, 80), from, x: Math.round(box.left), y: Math.round(box.top), width: Math.round((box.right - box.left) * 10) / 10, height: Math.round((box.bottom - box.top) * 10) / 10, inline });
}

// Headings, in the order of the page.
for (const el of document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"][aria-level]')) {
  if (!visible(el)) continue;
  if (facts.headings.length >= MAX_HEADINGS) { facts.partial = true; break; }
  const level = parseInt(el.getAttribute('aria-level') || (/^H[1-6]$/.test(el.tagName) ? el.tagName[1] : ''), 10);
  if (!(level >= 1 && level <= 9)) continue;
  const picture = el.querySelector('img[alt]');
  facts.headings.push({ selector: selectorOf(el), level, text: (said(el) || (picture ? squash(picture.getAttribute('alt')) : '')).slice(0, 80) });
}
return facts;`);

/** Brings an element into view and draws a box around it for a moment; false when the selector finds nothing. */
export function highlight(selector: string): string {
  return scoped(
    `
let el = null;
try { el = document.querySelector(arg); } catch (e) { return false; }
if (!el) return false;
el.scrollIntoView({ block: 'center', inline: 'center' });
if (window.__graftHighlight) window.__graftHighlight.remove();
const box = document.createElement('div');
box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #d9482b;background:rgba(217,72,43,.14);border-radius:4px;box-sizing:border-box;transition:opacity .4s';
window.__graftHighlight = box;
document.documentElement.append(box);
// The page may still be scrolling to it: the box follows for a while.
let frames = 0;
const place = () => {
  if (!box.isConnected) return;
  const r = el.getBoundingClientRect();
  Object.assign(box.style, { left: r.left - 3 + 'px', top: r.top - 3 + 'px', width: r.width + 6 + 'px', height: r.height + 6 + 'px' });
  if (++frames < 90) requestAnimationFrame(place);
};
place();
setTimeout(() => { box.style.opacity = '0'; }, 1500);
setTimeout(() => box.remove(), 2000);
return true;`,
    selector
  );
}

/** Finds an element by snapshot number, selector or visible text, scrolls it into view and says where it is. */
export function locate(target: { ref?: number; selector?: string; text?: string }): string {
  return scoped(
    `
let el = null;
if (arg.ref) el = (window.__graftRefs || [])[arg.ref - 1] || null;
if (!el && arg.selector) { try { el = document.querySelector(arg.selector); } catch (e) { return { ok: false, reason: 'That selector is not valid CSS: ' + e.message }; } }
if (!el && arg.text) {
  const want = arg.text.trim().toLowerCase();
  const candidates = [...document.querySelectorAll('a, button, input, textarea, select, summary, label, [role], [tabindex], [onclick]')].filter(visible);
  el = candidates.find((c) => labelOf(c).toLowerCase() === want) || candidates.find((c) => labelOf(c).toLowerCase().includes(want)) || null;
}
if (!el || !el.isConnected) return { ok: false, reason: 'No element matches. Take a new snapshot with action "read" and use one of its numbers.' };
el.scrollIntoView({ block: 'center', inline: 'center' });
const r = el.getBoundingClientRect();
window.__graftTarget = el;
return { ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2, label: labelOf(el), selector: selectorOf(el), disabled: el.disabled === true, editable: el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) };`,
    target
  );
}

/** Types into the element the last locate() found, the way a person would, so frameworks see the change. */
export function fill(text: string, submit: boolean): string {
  return scoped(
    `
const el = window.__graftTarget;
if (!el || !el.isConnected) return { ok: false, reason: 'The element is gone.' };
el.focus();
if (el.isContentEditable) {
  document.execCommand('selectAll', false);
  document.execCommand('insertText', false, arg.text);
} else if (el.tagName === 'SELECT') {
  const option = [...el.options].find((o) => o.value === arg.text || o.text.trim() === arg.text);
  if (!option) return { ok: false, reason: 'No option "' + arg.text + '". Options: ' + [...el.options].map((o) => o.text.trim()).join(', ') };
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, option.value);
} else {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, arg.text);
}
el.dispatchEvent(new Event('input', { bubbles: true }));
el.dispatchEvent(new Event('change', { bubbles: true }));
if (arg.submit) {
  if (el.form && el.form.requestSubmit) el.form.requestSubmit();
  else {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  }
}
return { ok: true };`,
    { text, submit }
  );
}

/** Whether the page shows some text yet. */
export function hasText(text: string): string {
  return scoped(`return (document.body ? document.body.innerText : '').toLowerCase().includes(String(arg).toLowerCase());`, text);
}

/** Scrolls by most of a screen. */
export function scrollBy(direction: 'up' | 'down'): string {
  return scoped(`window.scrollBy(0, (arg === 'down' ? 1 : -1) * window.innerHeight * 0.8); return true;`, direction);
}
