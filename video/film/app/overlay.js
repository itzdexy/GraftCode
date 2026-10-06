// What a screenshot of a page can't show on its own: the window's caption buttons (Windows draws
// them over the titlebar), the text caret and the mouse pointer. Each is drawn here so it is part
// of the footage and follows the virtual clock.
(function () {
  const style = document.createElement('style');
  style.textContent = `
    textarea, input { caret-color: transparent !important; }
    #cap-controls { position: fixed; top: 0; right: 0; height: 32px; display: flex; z-index: 2147483000; pointer-events: none; color: var(--g-icon); }
    #cap-controls span { width: 46px; height: 32px; display: grid; place-items: center; }
    #cap-caret { position: fixed; width: 1px; z-index: 2147483001; pointer-events: none; display: none; }
    #cap-cursor { position: fixed; left: 0; top: 0; z-index: 2147483002; pointer-events: none; display: none; transform-origin: 0 0; filter: drop-shadow(0 1px 1.5px rgb(0 0 0 / 0.45)); }
  `;

  const glyph = (d) => `<span><svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1">${d}</svg></span>`;
  const controls = document.createElement('div');
  controls.id = 'cap-controls';
  controls.innerHTML = glyph('<path d="M0 5.5h10"/>') + glyph('<rect x="0.5" y="0.5" width="9" height="9" rx="1.5"/>') + glyph('<path d="M0.5 0.5l9 9M9.5 0.5l-9 9"/>');

  const caret = document.createElement('div');
  caret.id = 'cap-caret';

  const cursor = document.createElement('div');
  cursor.id = 'cap-cursor';
  cursor.innerHTML =
    '<svg width="18" height="26" viewBox="0 0 14 20.5" fill="none"><path d="M1 1v16.2l4.1-3.8 2.5 5.8 2.4-1-2.5-5.8h5.4L1 1z" fill="#fff" stroke="#141414" stroke-width="1.05" stroke-linejoin="round"/></svg>';

  function mount() {
    document.head.append(style);
    document.body.append(controls, caret, cursor);
  }
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);

  // Where the caret sits in a textarea or input: lay the text up to it out in a copy of the field.
  const COPIED = ['boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariationSettings', 'fontFeatureSettings', 'fontOpticalSizing', 'letterSpacing', 'lineHeight', 'textTransform', 'wordSpacing', 'textIndent', 'tabSize'];
  function caretBox(el) {
    const from = getComputedStyle(el);
    const copy = document.createElement('div');
    for (const key of COPIED) copy.style[key] = from[key];
    copy.style.cssText += ';position:absolute;left:-99999px;top:0;visibility:hidden;border-style:solid;overflow-wrap:break-word;';
    copy.style.whiteSpace = el.tagName === 'INPUT' ? 'pre' : 'pre-wrap';
    copy.textContent = el.value.slice(0, el.selectionEnd ?? el.value.length);
    const mark = document.createElement('span');
    mark.textContent = String.fromCharCode(0x200b);
    copy.append(mark);
    document.body.append(copy);
    const m = mark.getBoundingClientRect();
    const base = copy.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    copy.remove();
    const x = box.left + (m.left - base.left) - el.scrollLeft;
    // An input sets its one line in the middle of its box, whatever its padding.
    if (el.tagName === 'INPUT') return { x, y: box.top + (box.height - m.height) / 2, height: m.height, color: from.color };
    return { x, y: box.top + (m.top - base.top) - el.scrollTop, height: m.height, color: from.color };
  }

  let typedAt = 0;
  const typed = () => {
    typedAt = window.__clock.now();
  };
  for (const type of ['input', 'focusin', 'keydown']) document.addEventListener(type, typed, true);

  window.__clock.onFrame((now) => {
    const el = document.activeElement;
    const field = el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|search|url|email|password|)$/.test(el.type))) ? el : null;
    if (!field) {
      caret.style.display = 'none';
      return;
    }
    const at = caretBox(field);
    const since = now - typedAt;
    // Solid while typing, then the system's blink (530 ms on, 530 ms off).
    const lit = since < 530 || Math.floor(since / 530) % 2 === 0;
    caret.style.cssText = `display:block;left:${at.x}px;top:${at.y}px;height:${at.height}px;background:${at.color};opacity:${lit ? 1 : 0}`;
  });

  // The pointer is drawn only while the mouse is over the window, so it comes in from an edge
  // the way a real one does.
  let pressed = false;
  let shown = false;
  let inside = false;
  let x = 0;
  let y = 0;
  const place = () => {
    cursor.style.display = shown && inside ? 'block' : 'none';
    cursor.style.transform = `translate(${x - 1}px, ${y - 1}px) scale(${pressed ? 0.9 : 1})`;
  };
  window.addEventListener(
    'mousemove',
    (event) => {
      inside = true;
      x = event.clientX;
      y = event.clientY;
      place();
    },
    true
  );
  // Leaving for nowhere in this page means leaving the window.
  document.addEventListener('mouseout', (event) => {
    if (event.relatedTarget !== null) return;
    inside = false;
    place();
  });
  window.addEventListener('mousedown', () => ((pressed = true), place()), true);
  window.addEventListener('mouseup', () => ((pressed = false), place()), true);
  window.__pointer = {
    show(visible) {
      shown = visible;
      place();
    }
  };
})();
