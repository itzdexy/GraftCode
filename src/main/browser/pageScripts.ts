/**
 * Scripts the Browser panel runs inside pages. They run in an isolated world:
 * they share the page's DOM but none of its JavaScript, so the page can't see,
 * call or tamper with them. State they keep (the element references from the
 * last snapshot) lives in that world and goes away with the page.
 */

/** Isolated world id for Graft's page scripts (any number that pages can't pick). */
export const GRAFT_WORLD = 7311;

/** A CSS selector for an element, preferring ids and test ids over position. */
const SELECTOR_OF = `
const __graftEsc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\\\' + c));
const __graftSelector = (el) => {
  if (el.id) return '#' + __graftEsc(el.id);
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node !== document.documentElement && parts.length < 5) {
    const testId = node.getAttribute('data-testid');
    if (testId) { parts.unshift(node.tagName.toLowerCase() + '[data-testid="' + testId.replace(/"/g, '\\\\"') + '"]'); break; }
    if (node.id) { parts.unshift('#' + __graftEsc(node.id)); break; }
    let part = node.tagName.toLowerCase();
    const classes = [...node.classList].filter((c) => !/^(css|sc|jsx|emotion)-/.test(c) && !c.startsWith('_') && !(/\\d/.test(c) && c.length >= 5)).slice(0, 2);
    if (classes.length > 0) part += '.' + classes.map(__graftEsc).join('.');
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
const __graftLabel = (el) => (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
const __graftVisible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
`;

/** Picks an element with the mouse: resolves with what was clicked, or null on Escape. */
export const PICK_ELEMENT = `${SELECTOR_OF}
new Promise((resolve) => {
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
    tag.textContent = __graftSelector(el) + '  ' + Math.round(r.width) + '×' + Math.round(r.height);
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
      selector: __graftSelector(el),
      html: el.outerHTML.slice(0, 6000),
      text: (el.innerText || '').trim().slice(0, 1500),
      size: { width: Math.round(r.width), height: Math.round(r.height) },
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
})`;

export const CANCEL_PICK = 'if (window.__graftPickDone) window.__graftPickDone(null); true';

/**
 * What the agent reads of a page: its text, and the elements it can act on,
 * numbered. The numbers stay valid until the next snapshot or navigation.
 */
export const SNAPSHOT = `${SELECTOR_OF}
(() => {
  const refs = [];
  const items = [];
  const query = 'a[href], button, input:not([type=hidden]), textarea, select, summary, [role=button], [role=link], [role=tab], [role=checkbox], [role=radio], [role=switch], [role=menuitem], [role=option], [contenteditable=""], [contenteditable=true]';
  for (const el of document.querySelectorAll(query)) {
    if (!__graftVisible(el)) continue;
    refs.push(el);
    const tagName = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || (tagName === 'a' ? 'link' : tagName === 'input' ? 'input[' + (el.type || 'text') + ']' : tagName);
    const item = { ref: refs.length, role, label: __graftLabel(el), selector: __graftSelector(el) };
    if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') item.value = String(el.value || '').slice(0, 80);
    if (el.type === 'checkbox' || el.type === 'radio') item.checked = el.checked;
    if (el.disabled) item.disabled = true;
    items.push(item);
    if (refs.length >= 150) break;
  }
  window.__graftRefs = refs;
  const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim();
  return { title: document.title, url: location.href, text: text.slice(0, 8000), truncated: text.length > 8000, items };
})()`;

/** Finds an element by snapshot number, selector or visible text, scrolls it into view and says where it is. */
export function locate(target: { ref?: number; selector?: string; text?: string }): string {
  return `${SELECTOR_OF}
((target) => {
  let el = null;
  if (target.ref) el = (window.__graftRefs || [])[target.ref - 1] || null;
  if (!el && target.selector) { try { el = document.querySelector(target.selector); } catch (e) { return { ok: false, reason: 'That selector is not valid CSS: ' + e.message }; } }
  if (!el && target.text) {
    const want = target.text.trim().toLowerCase();
    const candidates = [...document.querySelectorAll('a, button, input, textarea, select, summary, label, [role], [tabindex], [onclick]')].filter(__graftVisible);
    el = candidates.find((c) => __graftLabel(c).toLowerCase() === want) || candidates.find((c) => __graftLabel(c).toLowerCase().includes(want)) || null;
  }
  if (!el || !el.isConnected) return { ok: false, reason: 'No element matches. Take a new snapshot with action "read" and use one of its numbers.' };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  window.__graftTarget = el;
  return { ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2, label: __graftLabel(el), selector: __graftSelector(el), disabled: el.disabled === true, editable: el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) };
})(${JSON.stringify(target)})`;
}

/** Types into the element the last locate() found, the way a person would, so frameworks see the change. */
export function fill(text: string, submit: boolean): string {
  return `((text, submit) => {
  const el = window.__graftTarget;
  if (!el || !el.isConnected) return { ok: false, reason: 'The element is gone.' };
  el.focus();
  if (el.isContentEditable) {
    document.execCommand('selectAll', false);
    document.execCommand('insertText', false, text);
  } else if (el.tagName === 'SELECT') {
    const option = [...el.options].find((o) => o.value === text || o.text.trim() === text);
    if (!option) return { ok: false, reason: 'No option "' + text + '". Options: ' + [...el.options].map((o) => o.text.trim()).join(', ') };
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, option.value);
  } else {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  if (submit) {
    if (el.form && el.form.requestSubmit) el.form.requestSubmit();
    else {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    }
  }
  return { ok: true };
})(${JSON.stringify(text)}, ${submit ? 'true' : 'false'})`;
}

/** Whether the page shows some text yet. */
export function hasText(text: string): string {
  return `(document.body ? document.body.innerText : '').toLowerCase().includes(${JSON.stringify(text.toLowerCase())})`;
}
