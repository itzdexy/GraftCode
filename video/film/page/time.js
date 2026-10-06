// Runs before a page's own scripts. Replaces the page's clock with one the film script
// steps a frame at a time, so every frame of footage is drawn at an exact moment:
// timers, requestAnimationFrame, Date and performance.now follow the virtual clock, and
// CSS animations and transitions are paused and moved to it before each screenshot.
(function () {
  const RealDate = Date;
  const realTimeout = window.setTimeout.bind(window);
  const realFrame = window.requestAnimationFrame.bind(window);

  // The wall clock the footage is "filmed" at (local time), so any timestamp in the UI is stable.
  const EPOCH = new RealDate(2026, 9, 6, 10, 24, 0).getTime();
  let now = 0;
  let nextId = 1;
  let depth = 0;
  const timers = new Map();
  const frames = new Map();
  const hooks = [];

  function addTimer(fn, delay, args, every) {
    if (typeof fn !== 'function') return 0;
    const id = nextId++;
    // A timer set from inside a timer waits at least 1 ms, so a chain can't spin inside one frame.
    const wait = Math.max(depth > 0 ? 1 : 0, Number(delay) || 0);
    timers.set(id, { id, at: now + wait, fn, args, every });
    return id;
  }
  window.setTimeout = (fn, delay, ...args) => addTimer(fn, delay, args, null);
  window.setInterval = (fn, delay, ...args) => addTimer(fn, delay, args, Math.max(1, Number(delay) || 0));
  window.clearTimeout = window.clearInterval = (id) => void timers.delete(id);
  window.requestAnimationFrame = (fn) => {
    const id = nextId++;
    frames.set(id, fn);
    return id;
  };
  window.cancelAnimationFrame = (id) => void frames.delete(id);
  performance.now = () => now;

  function VirtualDate(...args) {
    if (!new.target) return new RealDate(EPOCH + now).toString();
    return Reflect.construct(RealDate, args.length > 0 ? args : [EPOCH + now], new.target);
  }
  VirtualDate.prototype = RealDate.prototype;
  Object.setPrototypeOf(VirtualDate, RealDate);
  VirtualDate.now = () => EPOCH + now;
  window.Date = VirtualDate;

  // A real macrotask: lets promise continuations and React's scheduler run between virtual timers.
  const channel = new MessageChannel();
  const waiting = [];
  channel.port1.onmessage = () => {
    const resolve = waiting.shift();
    if (resolve) resolve();
  };
  const macrotask = () =>
    new Promise((resolve) => {
      waiting.push(resolve);
      channel.port2.postMessage(0);
    });

  function run(fn, args) {
    depth += 1;
    try {
      fn(...args);
    } catch (error) {
      console.error('[film] timer failed', error);
    } finally {
      depth -= 1;
    }
  }

  // Smooth scrolling is the browser's own animation on the real clock; this one follows the virtual clock.
  const scrolls = new Map();
  const nativeScrollTo = Element.prototype.scrollTo;
  Element.prototype.scrollTo = function (...args) {
    const options = args[0];
    if (args.length === 1 && options && typeof options === 'object' && options.behavior === 'smooth') {
      scrolls.set(this, { from: this.scrollTop, to: options.top ?? this.scrollTop, start: now, duration: 320 });
      return;
    }
    scrolls.delete(this);
    nativeScrollTo.apply(this, args);
  };
  function stepScrolls() {
    for (const [el, s] of scrolls) {
      const t = Math.min(1, (now - s.start) / s.duration);
      const eased = 1 - Math.pow(1 - t, 3);
      nativeScrollTo.call(el, { top: s.from + (Math.min(s.to, el.scrollHeight - el.clientHeight) - s.from) * eased, behavior: 'instant' });
      if (t >= 1) scrolls.delete(el);
    }
  }

  // CSS animations, transitions and element.animate(): each one is paused when first seen and
  // from then on sits at "virtual time since it was seen".
  const seen = new WeakMap();
  function seekAnimations() {
    for (const animation of document.getAnimations()) {
      if (animation.playState === 'finished' || animation.playState === 'idle') continue;
      let start = seen.get(animation);
      if (start === undefined) {
        start = now;
        seen.set(animation, start);
      }
      const at = now - start;
      const end = animation.effect ? animation.effect.getComputedTiming().endTime : Infinity;
      try {
        if (Number.isFinite(end) && at >= end) {
          animation.finish();
        } else {
          animation.pause();
          animation.currentTime = at;
        }
      } catch (error) {
        console.error('[film] could not seek an animation', error);
      }
    }
  }

  // The stage page holds the app in a frame; each page has its own clock, and the stage's
  // moves the app's with it, so one call from the film script steps everything.
  const children = [];
  const each = (step) => Promise.all(children.map((child) => step(child).catch((error) => console.error('[film] a framed page fell off the clock', error))));

  window.__clock = {
    now: () => now,
    onFrame(fn) {
      hooks.push(fn);
    },
    adopt(child) {
      children.push(child);
    },
    /** Moves the clock forward, running every timer that falls due on the way, then one animation frame. */
    async advance(ms) {
      if (children.length > 0) await Promise.all([each((child) => child.advance(ms)), this.advanceSelf(ms)]);
      else await this.advanceSelf(ms);
    },
    async advanceSelf(ms) {
      const target = now + ms;
      for (let guard = 0; guard < 5000; guard++) {
        let due = null;
        for (const t of timers.values()) if (t.at <= target && (!due || t.at < due.at || (t.at === due.at && t.id < due.id))) due = t;
        if (!due) break;
        now = Math.max(now, due.at);
        if (due.every) due.at += due.every;
        else timers.delete(due.id);
        run(due.fn, due.args);
        await macrotask();
      }
      now = target;
      const callbacks = [...frames.values()];
      frames.clear();
      for (const fn of callbacks) run(fn, [now]);
      await macrotask();
    },
    /** Lets the page finish rendering what the last step caused, then puts every animation on the clock. */
    async settle() {
      await each((child) => child.settle());
      await macrotask();
      // A real frame lets layout effects and observers run; the timeout covers a page that draws none.
      await new Promise((resolve) => {
        realFrame(() => resolve());
        realTimeout(resolve, 60);
      });
      await macrotask();
      stepScrolls();
      for (const fn of hooks) fn(now);
      seekAnimations();
    }
  };

  try {
    if (window.parent !== window && window.parent.__clock && location.protocol !== 'about:') window.parent.__clock.adopt(window.__clock);
  } catch {
    // A frame from another origin keeps its own time; the film never embeds one.
  }
})();
