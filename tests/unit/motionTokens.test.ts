import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const STYLES = path.join(__dirname, '..', '..', 'src', 'renderer', 'src', 'styles');
const tokens = fs.readFileSync(path.join(STYLES, 'tokens.css'), 'utf8');
const globals = fs.readFileSync(path.join(STYLES, 'globals.css'), 'utf8');

describe('the lively motion style in the stylesheet', () => {
  const at = tokens.indexOf(":root[data-motion-style='lively']");
  const stillFromSystem = tokens.indexOf('@media (prefers-reduced-motion: reduce)');
  const stillFromSetting = tokens.lastIndexOf(":root[data-motion='reduced']");

  it('has times of its own for a change of page and for what springs', () => {
    const lively = /:root\[data-motion-style='lively'\]\s*\{([\s\S]*?)\n\}/.exec(tokens)?.[1] ?? '';
    expect(lively).toMatch(/--g-duration-view:\s*300ms/);
    expect(lively).toMatch(/--g-duration-lively:\s*380ms/);
    expect(lively).toMatch(/--g-ease-lively:\s*linear\(/);
  });

  it('never outlasts a request for less motion: the rules that set every time to nothing come after it and name its times', () => {
    // Selectors of the same weight: the later one wins.
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(stillFromSystem);
    expect(at).toBeLessThan(stillFromSetting);
    expect(tokens.slice(stillFromSystem, stillFromSetting)).toMatch(/--g-duration-lively:\s*0ms/);
    expect(tokens.slice(stillFromSetting)).toMatch(/--g-duration-lively:\s*0ms/);
    expect(tokens.slice(stillFromSetting)).toMatch(/--g-duration-view:\s*0ms/);
  });

  it('takes every one of its times from the tokens, so none of it moves once they are nothing', () => {
    const rules = globals.slice(globals.indexOf('@keyframes graft-page-out'), globals.indexOf('/* Reduced motion (see tokens.css)'));
    const animations = [...rules.matchAll(/animation:\s*([^;]+);/g)].map((m) => m[1]!);
    expect(animations.length).toBeGreaterThanOrEqual(7);
    for (const animation of animations) expect(animation, animation).toMatch(/var\(--g-duration-(lively|view|exit|slow)\)/);
    // Its delays are plain numbers, and the rules for reduced motion set every delay to nothing.
    expect(globals.slice(globals.indexOf('/* Reduced motion (see tokens.css)'))).toMatch(/animation-delay:\s*0ms\s*!important/);
  });

  it('moves the page in a frame of its own only while a page is changing', () => {
    expect(globals).toContain(":root[data-motion-style='lively'][data-view-change='page'] .graft-page");
    expect(globals).toMatch(/::view-transition-new\(graft-page\)\s*\{\s*animation:\s*graft-page-in var\(--g-duration-view\)/);
  });
});
