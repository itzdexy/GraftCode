import { describe, expect, it } from 'vitest';
import { checkPage, contrastRatio, formatPageCheck, MAX_FINDINGS, type PageFacts, type Rgba } from '../../src/main/browser/pageCheck';

const BLACK: Rgba = [0, 0, 0, 1];
const WHITE: Rgba = [255, 255, 255, 1];
const grey = (v: number, a = 1): Rgba => [v, v, v, a];

/** A page with nothing wrong: each test adds what it is about. */
function facts(more: Partial<PageFacts> = {}): PageFacts {
  return {
    url: 'http://localhost:5173/',
    title: 'Peach Palace',
    lang: 'en',
    viewportMeta: true,
    width: 1280,
    scrollWidth: 1280,
    texts: [{ selector: 'h1', text: 'Peach Palace', color: BLACK, backgrounds: [WHITE], unsure: false, size: 40, bold: true }],
    images: [],
    controls: [],
    headings: [{ selector: 'h1', level: 1, text: 'Peach Palace' }],
    wide: [],
    partial: false,
    ...more
  };
}

const text = (selector: string, color: Rgba, backgrounds: Rgba[], more: Partial<PageFacts['texts'][number]> = {}): PageFacts['texts'][number] => ({ selector, text: selector, color, backgrounds, unsure: false, size: 16, bold: false, ...more });
const rules = (page: PageFacts): string[] => checkPage(page).findings.map((finding) => `${finding.severity} ${finding.rule}`);

describe('contrast between a text and what is behind it', () => {
  it('is 21 for black on white and 1 for a colour on itself', () => {
    expect(contrastRatio(BLACK, [WHITE])).toBeCloseTo(21, 5);
    expect(contrastRatio(WHITE, [WHITE])).toBeCloseTo(1, 5);
  });

  it('puts the line where the guideline does', () => {
    expect(contrastRatio(grey(0x76), [WHITE])).toBeGreaterThan(4.5);
    expect(contrastRatio(grey(0x77), [WHITE])).toBeLessThan(4.5);
  });

  it('sees a see-through text as the colour it mixes to', () => {
    expect(contrastRatio(grey(0, 0.5), [WHITE])).toBeCloseTo(contrastRatio(grey(128), [WHITE]), 1);
  });

  it('lays the backgrounds over each other, the nearest on top, with white under them all', () => {
    // A half-black layer over nothing is mid grey: white text on it reads about as on #808080.
    expect(contrastRatio(WHITE, [grey(0, 0.5)])).toBeCloseTo(contrastRatio(WHITE, [grey(128)]), 1);
    // The nearest is on top: an opaque white card on a black page is white.
    expect(contrastRatio(BLACK, [WHITE, BLACK])).toBeCloseTo(21, 5);
  });
});

describe('a page with nothing wrong', () => {
  it('has no findings, and says what was looked at', () => {
    const check = checkPage(facts());
    expect(check.findings).toEqual([]);
    expect(check).toMatchObject({ url: 'http://localhost:5173/', title: 'Peach Palace', width: 1280, more: 0, unjudged: 0, partial: false, looked: { texts: 1, images: 0, controls: 0, headings: 1 } });
  });
});

describe('text that is hard to read', () => {
  it('is found once for each pair of colours, with how often', () => {
    const check = checkPage(facts({ texts: [text('nav > a:nth-of-type(1)', grey(0x99), [WHITE], { text: 'Menu' }), text('nav > a:nth-of-type(2)', grey(0x99), [WHITE]), text('p', BLACK, [WHITE])] }));
    expect(check.findings).toEqual([
      { rule: 'contrast', severity: 'error', message: 'Contrast 2.84:1 where 4.5:1 is needed: #999999 on #ffffff, in 2 places.', selector: 'nav > a:nth-of-type(1)', label: 'Menu' }
    ]);
  });

  it('asks less of large text, and of bold text from 18.66 px', () => {
    const light = grey(0x8a);
    expect(rules(facts({ texts: [text('h2', light, [WHITE], { size: 24 })] }))).toEqual([]);
    expect(rules(facts({ texts: [text('b', light, [WHITE], { size: 19, bold: true })] }))).toEqual([]);
    expect(rules(facts({ texts: [text('p', light, [WHITE], { size: 19 })] }))).toEqual(['error contrast']);
    expect(checkPage(facts({ texts: [text('h2', grey(0xbb), [WHITE], { size: 24 })] })).findings[0]?.message).toContain('where 3:1 is needed');
  });

  it('is not judged over a picture or a gradient, and says how many were not', () => {
    const check = checkPage(facts({ texts: [text('.hero h1', WHITE, [], { unsure: true }), text('.hero p', WHITE, [], { unsure: true })] }));
    expect(check.findings).toEqual([]);
    expect(check.unjudged).toBe(2);
  });
});

describe('pictures', () => {
  it('need alt text, and an empty one says the picture is decoration', () => {
    const page = facts({ images: [{ selector: 'img.hero', alt: null, label: 'hero.jpg', broken: false }, { selector: 'img.rule', alt: '', label: 'rule.svg', broken: false }] });
    expect(checkPage(page).findings).toEqual([{ rule: 'image', severity: 'error', message: 'A picture with no alt text.', selector: 'img.hero', label: 'hero.jpg' }]);
  });

  it('are named when they did not load', () => {
    const page = facts({ images: [{ selector: 'img.logo', alt: 'Peach Palace', label: 'logo.png', broken: true }] });
    expect(checkPage(page).findings).toEqual([{ rule: 'image', severity: 'error', message: 'A picture that did not load.', selector: 'img.logo', label: 'logo.png' }]);
  });
});

describe('buttons, links and fields', () => {
  const control = (more: Partial<PageFacts['controls'][number]>): PageFacts['controls'][number] => ({ selector: 'button', kind: 'button', name: 'Order', from: 'content', x: 400, y: 400, width: 120, height: 40, inline: false, ...more });

  it('need a name', () => {
    const check = checkPage(facts({ controls: [control({ selector: 'button.close', name: '', from: 'none' })] }));
    expect(check.findings).toEqual([{ rule: 'name', severity: 'error', message: 'A button with no name: a screen reader says only "button".', selector: 'button.close', label: '' }]);
  });

  it('are warned about when a placeholder is all the name a field has', () => {
    const check = checkPage(facts({ controls: [control({ selector: '#email', kind: 'input[email]', name: 'Email', from: 'placeholder' })] }));
    expect(check.findings).toEqual([{ rule: 'name', severity: 'warning', message: 'A field named only by its placeholder, which is gone once someone types.', selector: '#email', label: 'Email' }]);
  });

  const close = control({ selector: 'button.x', name: 'Close', x: 100, y: 10, width: 16, height: 16 });
  const pin = control({ selector: 'button.pin', name: 'Pin', x: 120, y: 10, width: 16, height: 16 });

  it('are warned about when they are small and another is within reach', () => {
    const message = 'A 16×16 px target with another one within 24 px of it: easy to hit the wrong one.';
    expect(checkPage(facts({ controls: [close, pin] })).findings).toEqual([
      { rule: 'target', severity: 'warning', message, selector: 'button.x', label: 'Close' },
      { rule: 'target', severity: 'warning', message, selector: 'button.pin', label: 'Pin' }
    ]);
    // A target of full size beside a small one: only the small one is hard to hit.
    expect(checkPage(facts({ controls: [close, control({ selector: 'button.big', x: 118, y: 0 })] })).findings.map((finding) => finding.selector)).toEqual(['button.x']);
  });

  it('may be small when nothing else is near: the guideline asks for room, not for size', () => {
    expect(rules(facts({ controls: [close] }))).toEqual([]);
    expect(rules(facts({ controls: [close, { ...pin, x: 132 }] }))).toEqual([]);
    // An unstyled button is 21 px tall, and fine among others that are stacked or spaced.
    expect(rules(facts({ controls: [control({ x: 0, y: 0, width: 80, height: 21 }), control({ x: 0, y: 25, width: 80, height: 21 }), control({ x: 90, y: 0, width: 80, height: 21 })] }))).toEqual([]);
  });

  it('are left alone when they are a link in a sentence', () => {
    const terms = control({ selector: 'p > a', kind: 'link', name: 'terms', x: 100, y: 12, width: 38, height: 17, inline: true });
    expect(rules(facts({ controls: [terms, control({ ...terms, selector: 'p > a + a', x: 142 })] }))).toEqual([]);
  });
});

describe('headings', () => {
  it('are warned about when a level is skipped', () => {
    const page = facts({ headings: [{ selector: 'h1', level: 1, text: 'Peach Palace' }, { selector: 'h4', level: 4, text: 'Opening hours' }] });
    expect(checkPage(page).findings).toEqual([{ rule: 'heading', severity: 'warning', message: 'Heading levels jump from h1 to h4.', selector: 'h4', label: 'Opening hours' }]);
  });

  it('may go back up any number of levels', () => {
    expect(rules(facts({ headings: [{ selector: 'h1', level: 1, text: 'A' }, { selector: 'h2', level: 2, text: 'B' }, { selector: 'h3', level: 3, text: 'C' }, { selector: 'h2', level: 2, text: 'D' }] }))).toEqual([]);
  });

  it('need a main one, and words in each', () => {
    expect(checkPage(facts({ headings: [{ selector: 'h2', level: 2, text: 'Menu' }] })).findings).toEqual([{ rule: 'heading', severity: 'warning', message: 'No main heading (h1).', selector: '', label: '' }]);
    expect(checkPage(facts({ headings: [{ selector: 'h1', level: 1, text: 'A' }, { selector: 'h2.gap', level: 2, text: '' }] })).findings).toEqual([{ rule: 'heading', severity: 'error', message: 'An empty h2 heading.', selector: 'h2.gap', label: '' }]);
  });
});

describe('a page wider than its window', () => {
  it('is an error, with what sticks out', () => {
    const page = facts({ width: 390, scrollWidth: 512, wide: [{ selector: 'table.prices', label: 'Prices', right: 512 }] });
    expect(checkPage(page).findings).toEqual([
      { rule: 'overflow', severity: 'error', message: 'The page is 122 px wider than its 390 px window, so it scrolls sideways.', selector: '', label: '' },
      { rule: 'overflow', severity: 'error', message: 'Runs 122 px past the right edge.', selector: 'table.prices', label: 'Prices' }
    ]);
  });

  it('is not one when what sticks out is cut off and nothing scrolls', () => {
    expect(rules(facts({ width: 390, scrollWidth: 390, wide: [{ selector: '.drawer', label: 'Menu', right: 700 }] }))).toEqual([]);
  });
});

describe('the page as a whole', () => {
  it('is warned about without a title, a language or a viewport tag', () => {
    expect(checkPage(facts({ title: '', lang: '', viewportMeta: false })).findings.map((finding) => finding.message)).toEqual([
      'The page has no title.',
      'The page does not say which language it is in (no lang on <html>).',
      'No viewport meta tag: a phone shows the page zoomed out.'
    ]);
  });
});

describe('the list of findings', () => {
  it('has the errors first', () => {
    const page = facts({ lang: '', images: [{ selector: 'img', alt: null, label: 'a.png', broken: false }], headings: [{ selector: 'h2', level: 2, text: 'Menu' }] });
    expect(rules(page)).toEqual(['error image', 'warning heading', 'warning document']);
  });

  it('stops at its limit and counts what it left out', () => {
    const images = Array.from({ length: MAX_FINDINGS + 7 }, (_, i) => ({ selector: `img:nth-of-type(${String(i + 1)})`, alt: null, label: `${String(i)}.png`, broken: false }));
    const check = checkPage(facts({ images }));
    expect(check.findings).toHaveLength(MAX_FINDINGS);
    expect(check.more).toBe(7);
  });
});

describe('what a page says about itself', () => {
  it('is not carried when it is too long to be a place: the finding stays, without one', () => {
    const long = `img.${'x'.repeat(400)}`;
    const check = checkPage(facts({ images: [{ selector: long, alt: null, label: 'hero.jpg', broken: false }] }));
    expect(check.findings).toEqual([{ rule: 'image', severity: 'error', message: 'A picture with no alt text.', selector: '', label: 'hero.jpg' }]);
  });

  it('is cut where it names or quotes something at length', () => {
    const check = checkPage(facts({ images: [{ selector: 'img', alt: null, label: 'y'.repeat(500), broken: false }] }));
    expect(check.findings[0]?.label).toHaveLength(120);
  });
});

describe('the check as the agent reads it', () => {
  it('counts, lists each finding with where it is, and says what was looked at', () => {
    const page = facts({
      width: 390,
      scrollWidth: 390,
      texts: [text('nav > a', grey(0x99), [WHITE], { text: 'Menu' }), text('.hero h1', WHITE, [], { unsure: true })],
      images: [{ selector: 'img.hero', alt: null, label: 'hero.jpg', broken: false }],
      lang: ''
    });
    expect(formatPageCheck(checkPage(page))).toBe(
      [
        'Checked Peach Palace (http://localhost:5173/) at 390 px wide: 2 problems, 1 warning.',
        '',
        'Problems:',
        '- Contrast 2.84:1 where 4.5:1 is needed: #999999 on #ffffff. At nav > a ("Menu")',
        '- A picture with no alt text. At img.hero ("hero.jpg")',
        '',
        'Warnings:',
        '- The page does not say which language it is in (no lang on <html>).',
        '',
        'Looked at 2 texts, 1 picture, 0 controls and 1 heading. Contrast was not judged for 1 text over a picture or a gradient.'
      ].join('\n')
    );
  });

  it('says so when nothing was found, and when the page had more than was looked at', () => {
    expect(formatPageCheck(checkPage(facts()))).toBe(['Checked Peach Palace (http://localhost:5173/) at 1280 px wide: nothing found.', '', 'Looked at 1 text, 0 pictures, 0 controls and 1 heading.'].join('\n'));
    expect(formatPageCheck(checkPage(facts({ partial: true })))).toContain('The page has more than was looked at.');
  });
});
