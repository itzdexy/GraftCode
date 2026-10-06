// The stage's moving parts, all on the film's clock (film/page/time.js): the camera behind the
// window, the caption under it, and the opening and closing titles. The film script
// (film/scenes.mjs) calls these through window.stage.
(function () {
  const FRAME = { x: 120, y: 54, w: 1680, h: 876 };
  const clock = window.__clock;
  const frame = document.getElementById('frame');
  const world = document.getElementById('world');
  const caption = document.getElementById('caption');
  const card = document.getElementById('card');
  let app = null;
  let size = { w: 1400, h: 730 };

  // ---------- Tweens ----------
  const tweens = new Set();
  /** cubic-bezier(x1, y1, x2, y2) as a function of time, like the CSS one. */
  function bezier(x1, y1, x2, y2) {
    const at = (a, b, t) => 3 * a * (1 - t) * (1 - t) * t + 3 * b * (1 - t) * t * t + t * t * t;
    return (x) => {
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        if (at(x1, x2, mid) < x) lo = mid;
        else hi = mid;
      }
      return at(y1, y2, (lo + hi) / 2);
    };
  }
  const EASE = {
    // A camera move: leaves gently, lands gently.
    move: bezier(0.62, 0, 0.2, 1),
    out: bezier(0.16, 1, 0.3, 1),
    linear: (t) => t
  };
  clock.onFrame((now) => {
    for (const t of tweens) {
      const p = Math.min(1, Math.max(0, (now - t.start) / t.ms));
      t.apply(t.ease(p));
      if (p >= 1) tweens.delete(t);
    }
  });

  // ---------- Camera ----------
  // x, y: the point of the app (in its own pixels) at the middle of the window. zoom: screen pixels per app pixel.
  const camera = { x: 700, y: 365, zoom: 1.2 };
  let cameraTween = null;
  const clamp = (v, lo, hi) => (lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)));
  function place() {
    const z = camera.zoom;
    const x = clamp(camera.x, FRAME.w / (2 * z), size.w - FRAME.w / (2 * z));
    const y = clamp(camera.y, FRAME.h / (2 * z), size.h - FRAME.h / (2 * z));
    world.style.transform = `translate(${FRAME.w / 2 - x * z}px, ${FRAME.h / 2 - y * z}px) scale(${z})`;
  }
  const fit = () => FRAME.w / size.w;

  /** A shot: the whole window ('wide'), or a box of the app with room around it. */
  function shot(target) {
    if (target === 'wide') return { x: size.w / 2, y: size.h / 2, zoom: fit() };
    const zoom = target.zoom ?? Math.min(FRAME.w / target.w, FRAME.h / target.h);
    return { x: target.x + (target.w ?? 0) / 2, y: target.y + (target.h ?? 0) / 2, zoom: Math.max(fit(), zoom) };
  }

  // ---------- Scion ----------
  let scion = null;
  function scionSvg(pixel, motion) {
    const fills = scion.fills;
    const part = { L: 'leaves', D: 'leaves', S: 'stem', R: 'pot', P: 'pot', E: 'eyes' };
    const cells = (rows, top = 0) => rows.flatMap((row, dy) => [...row].flatMap((c, x) => (fills[c] ? [{ x, y: top + dy, fill: `var(--g-mascot-${fills[c]})`, part: part[c] }] : [])));
    const rects = (list) => list.map((c) => `<rect x="${c.x}" y="${c.y}" width="1" height="1" fill="${c.fill}"/>`).join('');
    const sprite = cells(scion.sprite);
    const of = (name) => rects(sprite.filter((c) => c.part === name));
    const eyes = Object.entries(scion.frames.eyes).map(([name, row]) => `<g class="graft-frame graft-frame--${name}">${rects(cells([row], 5))}</g>`);
    const leaves = Object.entries(scion.frames.leaves).map(([name, rows]) => `<g class="graft-frame graft-frame--${name}">${rects(cells(rows).filter((c) => c.part === 'leaves'))}</g>`);
    const cols = scion.sprite[0].length;
    const rows = scion.sprite.length;
    return `<svg class="scion graft-mark graft-mark--${motion}" width="${cols * pixel}" height="${rows * pixel}" viewBox="0 0 ${cols} ${rows}" shape-rendering="crispEdges"><g class="graft-mark__body"><g class="graft-mark__pot">${of('pot')}<g class="graft-mark__eyes">${of('eyes')}</g>${eyes.join('')}</g><g class="graft-mark__stem">${of('stem')}</g><g class="graft-mark__leaves"><g class="graft-frame--rest">${of('leaves')}</g>${leaves.join('')}</g></g></svg>`;
  }

  window.stage = {
    /** Resolves once the stage's fonts and the mascot's sprite are in. */
    ready: Promise.all([fetch('/brand/scion.json').then((r) => r.json()), document.fonts.load("600 46px 'Newsreader'"), document.fonts.load("400 25px 'Geist'"), document.fonts.load("450 31px 'JetBrains Mono'")]).then(([sprite]) => {
      scion = sprite;
    }),

    /** Puts the app behind the window, `width` x `height` of its own pixels. */
    open(width, height) {
      size = { w: width, h: height };
      app = document.createElement('iframe');
      app.width = String(width);
      app.height = String(height);
      app.src = '/app/index.html';
      world.replaceChildren(app);
      Object.assign(camera, shot('wide'));
      place();
      return new Promise((resolve) => app.addEventListener('load', () => resolve(), { once: true }));
    },
    /** Shows the window: at once, or rising into place. */
    show(rise) {
      frame.classList.add('on');
      if (rise) frame.classList.add('rise');
    },

    /** The box of an element of the app, in the app's pixels (null when it isn't there). */
    box(selector) {
      const el = app.contentDocument.querySelector(selector);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    },
    /** Where a point of the app is on the stage. */
    toStage(x, y) {
      const r = app.getBoundingClientRect();
      const z = r.width / size.w;
      return { x: r.x + x * z, y: r.y + y * z };
    },

    /** Cuts the camera to a shot. */
    cut(target) {
      if (cameraTween) tweens.delete(cameraTween);
      Object.assign(camera, shot(target));
      place();
    },
    /** Moves the camera to a shot over `ms`. Zoom changes by ratio, so the move reads as even. */
    move(target, ms, ease = 'move') {
      if (cameraTween) tweens.delete(cameraTween);
      const from = { ...camera };
      const to = shot(target);
      cameraTween = {
        start: clock.now(),
        ms,
        ease: EASE[ease],
        apply(p) {
          camera.zoom = from.zoom * Math.pow(to.zoom / from.zoom, p);
          camera.x = from.x + (to.x - from.x) * p;
          camera.y = from.y + (to.y - from.y) * p;
          place();
        }
      };
      tweens.add(cameraTween);
    },

    caption(headline, detail) {
      caption.querySelector('h2 span').textContent = headline;
      caption.querySelector('p').textContent = detail;
      caption.classList.add('in');
    },

    /** The opening: Scion grows as it does when the app starts, then the name and what Graft is. */
    intro(tagline) {
      card.innerHTML = `<div class="intro">${scionSvg(13, 'draw')}<div class="wordmark"><span>Graft</span></div><p class="tagline"></p></div>`;
      card.querySelector('.tagline').textContent = tagline;
      card.classList.add('on');
    },
    /** The close: the name again, what it costs, and where to get it. */
    outro(line, address) {
      const [host, ...rest] = address.split('/');
      card.innerHTML = `<div class="outro">${scionSvg(13, 'cheer')}<div class="wordmark"><span>Graft</span></div><p class="tagline"></p><p class="address"><i></i><b></b></p></div>`;
      card.querySelector('.tagline').textContent = line;
      card.querySelector('.address i').textContent = `${host}/`;
      card.querySelector('.address b').textContent = rest.join('/');
      card.classList.add('on');
    },
    leave() {
      card.classList.add('leave');
    }
  };
})();
