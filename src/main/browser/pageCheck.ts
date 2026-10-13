/**
 * What is wrong with a page as someone meets it: text that is hard to read,
 * pictures and controls without a name, headings out of order, a layout
 * wider than its window. The page script (pageScripts.ts, PAGE_FACTS) only
 * gathers facts; the judging is here, where it can be tested without a page.
 *
 * The lines are the ones of the Web Content Accessibility Guidelines 2.2 at
 * level AA where they give a number: 4.5:1 for text, 3:1 for large text,
 * and 24 px of room for a target that is smaller than 24×24 px.
 */

import type { PageCheck, PageFinding } from '@shared/schemas/panels';

export { checkCounts, findingLine, formatPageCheck, lookedAt } from '@shared/pageCheck';
export type { PageCheck, PageFinding };

/** Red, green and blue from 0 to 255, and how opaque from 0 to 1. */
export type Rgba = [number, number, number, number];

export interface PageFacts {
  url: string;
  title: string;
  /** The language the page says it is in; empty when it does not say. */
  lang: string;
  viewportMeta: boolean;
  /** How wide the page is laid out, and how wide its content runs. */
  width: number;
  scrollWidth: number;
  texts: Array<{
    selector: string;
    text: string;
    color: Rgba;
    /** What is behind the text, the nearest first, down to the first that is opaque. */
    backgrounds: Rgba[];
    /** Behind it is a picture or a gradient, or the text is faded: its contrast cannot be worked out. */
    unsure: boolean;
    /** Font size in px. */
    size: number;
    bold: boolean;
  }>;
  images: Array<{ selector: string; alt: string | null; label: string; broken: boolean }>;
  controls: Array<{
    selector: string;
    /** "button", "link", or what kind of field: "input[email]", "select". */
    kind: string;
    name: string;
    /** Where the name comes from: its content or a label, a title, only a placeholder, or nowhere. */
    from: 'content' | 'label' | 'title' | 'placeholder' | 'none';
    /** Where it is in the page, from its top left corner. */
    x: number;
    y: number;
    width: number;
    height: number;
    /** A link inside a sentence, which the size of a target does not apply to. */
    inline: boolean;
  }>;
  headings: Array<{ selector: string; level: number; text: string }>;
  /** What reaches past the right edge of the window. */
  wide: Array<{ selector: string; label: string; right: number }>;
  /** A list was cut at its limit: the page has more than was looked at. */
  partial: boolean;
}

export const MAX_FINDINGS = 60;
const TEXT_CONTRAST = 4.5;
const LARGE_TEXT_CONTRAST = 3;
/** Large text: from 24 px, or from 18.66 px when it is bold (18 pt and 14 pt). */
const LARGE_PX = 24;
const LARGE_BOLD_PX = 18.66;
const MIN_TARGET_PX = 24;
const MAX_WIDE = 5;
const ORDER: Array<PageFinding['rule']> = ['overflow', 'contrast', 'name', 'image', 'heading', 'target', 'document'];

type Rgb = [number, number, number];

/** `top` laid over `under`. */
function over(top: Rgba, under: Rgb): Rgb {
  const a = Math.min(1, Math.max(0, top[3]));
  return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a)];
}

function luminance(color: Rgb): number {
  const linear = (channel: number): number => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(color[0]) + 0.7152 * linear(color[1]) + 0.0722 * linear(color[2]);
}

/** A text's colour and what is behind it, as they mix on a white page. */
function mixed(color: Rgba, backgrounds: Rgba[]): { text: Rgb; behind: Rgb } {
  let behind: Rgb = [255, 255, 255];
  for (let i = backgrounds.length - 1; i >= 0; i--) behind = over(backgrounds[i]!, behind);
  return { text: over(color, behind), behind };
}

function ratio(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** The contrast between a text and its backgrounds (the nearest first), from 1 to 21. */
export function contrastRatio(color: Rgba, backgrounds: Rgba[]): number {
  const { text, behind } = mixed(color, backgrounds);
  return ratio(text, behind);
}

function hex(color: Rgb): string {
  return `#${color.map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;
}

function contrastFindings(texts: PageFacts['texts']): PageFinding[] {
  const pairs = new Map<string, { finding: PageFinding; lead: string; count: number }>();
  for (const item of texts) {
    if (item.unsure) continue;
    const { text, behind } = mixed(item.color, item.backgrounds);
    const needs = item.size >= LARGE_PX || (item.bold && item.size >= LARGE_BOLD_PX) ? LARGE_TEXT_CONTRAST : TEXT_CONTRAST;
    const has = ratio(text, behind);
    if (has >= needs) continue;
    // One finding for a pair of colours however often it is used: it is one thing to put right.
    const key = `${hex(text)} ${hex(behind)} ${String(needs)}`;
    const pair = pairs.get(key);
    if (pair) {
      pair.count++;
      continue;
    }
    // Rounded down, so a ratio just under the line never reads as the line.
    const lead = `Contrast ${(Math.floor(has * 100) / 100).toFixed(2)}:1 where ${String(needs)}:1 is needed: ${hex(text)} on ${hex(behind)}`;
    pairs.set(key, { finding: { rule: 'contrast', severity: 'error', message: '', selector: item.selector, label: item.text }, lead, count: 1 });
  }
  return [...pairs.values()].map(({ finding, lead, count }) => ({ ...finding, message: `${lead}${count > 1 ? `, in ${String(count)} places` : ''}.` }));
}

type Control = PageFacts['controls'][number];

function small(control: Control): boolean {
  return control.width < MIN_TARGET_PX || control.height < MIN_TARGET_PX;
}

/**
 * Whether a circle of 24 px around the middle of a small target reaches another target: the other's own circle
 * when that one is small too, its box otherwise. A small target with room around it passes the guideline.
 */
function reaches(control: Control, other: Control): boolean {
  const cx = control.x + control.width / 2;
  const cy = control.y + control.height / 2;
  if (small(other)) return Math.hypot(cx - (other.x + other.width / 2), cy - (other.y + other.height / 2)) < MIN_TARGET_PX;
  const nearX = Math.min(Math.max(cx, other.x), other.x + other.width);
  const nearY = Math.min(Math.max(cy, other.y), other.y + other.height);
  return Math.hypot(cx - nearX, cy - nearY) < MIN_TARGET_PX / 2;
}

function controlFindings(controls: PageFacts['controls']): PageFinding[] {
  const out: PageFinding[] = [];
  for (const control of controls) {
    const at = { selector: control.selector, label: control.name };
    if (control.from === 'none') {
      const noun = /^(button|link|checkbox|radio|switch|tab|menuitem)$/.test(control.kind) ? control.kind : null;
      const message = noun ? `A ${noun} with no name: a screen reader says only "${noun}".` : 'A field with no label: a screen reader cannot say what it is for.';
      out.push({ rule: 'name', severity: 'error', message, ...at });
    } else if (control.from === 'placeholder') {
      out.push({ rule: 'name', severity: 'warning', message: 'A field named only by its placeholder, which is gone once someone types.', ...at });
    }
    if (!control.inline && small(control) && controls.some((other) => other !== control && reaches(control, other))) {
      const size = `${String(Math.round(control.width))}×${String(Math.round(control.height))}`;
      out.push({ rule: 'target', severity: 'warning', message: `A ${size} px target with another one within ${String(MIN_TARGET_PX)} px of it: easy to hit the wrong one.`, ...at });
    }
  }
  return out;
}

function headingFindings(page: PageFacts): PageFinding[] {
  const out: PageFinding[] = [];
  const { headings } = page;
  if (!headings.some((heading) => heading.level === 1) && (headings.length > 0 || page.texts.length > 0)) {
    out.push({ rule: 'heading', severity: 'warning', message: 'No main heading (h1).', selector: '', label: '' });
  }
  headings.forEach((heading, i) => {
    if (heading.text.trim().length === 0) out.push({ rule: 'heading', severity: 'error', message: `An empty h${String(heading.level)} heading.`, selector: heading.selector, label: '' });
    const before = headings[i - 1];
    if (before && heading.level > before.level + 1) {
      out.push({ rule: 'heading', severity: 'warning', message: `Heading levels jump from h${String(before.level)} to h${String(heading.level)}.`, selector: heading.selector, label: heading.text });
    }
  });
  return out;
}

function overflowFindings(page: PageFacts): PageFinding[] {
  // Something that sticks out and is cut off scrolls nothing: only a page that scrolls sideways is wrong.
  if (page.scrollWidth <= page.width + 1) return [];
  const extra = Math.round(page.scrollWidth - page.width);
  return [
    { rule: 'overflow', severity: 'error', message: `The page is ${String(extra)} px wider than its ${String(page.width)} px window, so it scrolls sideways.`, selector: '', label: '' },
    ...page.wide.slice(0, MAX_WIDE).map((item): PageFinding => ({ rule: 'overflow', severity: 'error', message: `Runs ${String(Math.round(item.right - page.width))} px past the right edge.`, selector: item.selector, label: item.label }))
  ];
}

function imageFindings(images: PageFacts['images']): PageFinding[] {
  const out: PageFinding[] = [];
  for (const image of images) {
    const at = { selector: image.selector, label: image.label };
    // An empty alt says the picture is decoration, which is an answer; none at all is not.
    if (image.alt === null) out.push({ rule: 'image', severity: 'error', message: 'A picture with no alt text.', ...at });
    if (image.broken) out.push({ rule: 'image', severity: 'error', message: 'A picture that did not load.', ...at });
  }
  return out;
}

function documentFindings(page: PageFacts): PageFinding[] {
  const out: PageFinding[] = [];
  const whole = { rule: 'document' as const, severity: 'warning' as const, selector: '', label: '' };
  if (page.title.trim().length === 0) out.push({ ...whole, message: 'The page has no title.' });
  if (page.lang.trim().length === 0) out.push({ ...whole, message: 'The page does not say which language it is in (no lang on <html>).' });
  if (!page.viewportMeta) out.push({ ...whole, message: 'No viewport meta tag: a phone shows the page zoomed out.' });
  return out;
}

/** Judges the facts of a page: the errors first, then the warnings, each kind together. */
export function checkPage(page: PageFacts): PageCheck {
  const all = [...overflowFindings(page), ...contrastFindings(page.texts), ...controlFindings(page.controls), ...imageFindings(page.images), ...headingFindings(page), ...documentFindings(page)];
  const rank = (finding: PageFinding): number => (finding.severity === 'error' ? 0 : ORDER.length) + ORDER.indexOf(finding.rule);
  // A stable sort: findings of one kind stay in the order of the page.
  const sorted = all.map((finding, i) => ({ finding, i })).sort((a, b) => rank(a.finding) - rank(b.finding) || a.i - b.i).map(({ finding }) => finding);
  return {
    url: page.url,
    title: page.title,
    width: page.width,
    findings: sorted.slice(0, MAX_FINDINGS),
    more: Math.max(0, sorted.length - MAX_FINDINGS),
    looked: { texts: page.texts.length, images: page.images.length, controls: page.controls.length, headings: page.headings.length },
    unjudged: page.texts.filter((item) => item.unsure).length,
    partial: page.partial
  };
}
