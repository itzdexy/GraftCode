import { describe, expect, it } from 'vitest';
import { checkHeadline, fixPageRequest, problemsFound } from '../../../src/renderer/src/features/panels/pageCheckModel';
import type { PageCheck, PageFinding } from '../../../src/shared/schemas/panels';

const finding = (more: Partial<PageFinding> = {}): PageFinding => ({ rule: 'image', severity: 'error', message: 'A picture with no alt text.', selector: 'img.hero', label: 'hero.jpg', ...more });

function check(more: Partial<PageCheck> = {}): PageCheck {
  return {
    url: 'http://localhost:5173/',
    title: 'Peach Palace',
    width: 390,
    findings: [finding(), finding({ rule: 'document', severity: 'warning', message: 'The page has no title.', selector: '', label: '' })],
    more: 0,
    looked: { texts: 12, images: 1, controls: 3, headings: 2 },
    unjudged: 0,
    partial: false,
    ...more
  };
}

describe('the headline of a page check', () => {
  it('counts what was found, at the width the page was laid out', () => {
    expect(checkHeadline(check())).toBe('1 problem, 1 warning at 390 px wide');
    expect(checkHeadline(check({ findings: [finding(), finding()], width: 1280 }))).toBe('2 problems at 1280 px wide');
  });

  it('says so when nothing was found', () => {
    expect(checkHeadline(check({ findings: [] }))).toBe('Nothing found at 390 px wide');
  });
});

describe('the number on the check button', () => {
  it('counts the problems, and is nothing for warnings alone or before a check', () => {
    expect(problemsFound(check())).toBe(1);
    expect(problemsFound(check({ findings: [finding({ severity: 'warning' })] }))).toBe(0);
    expect(problemsFound(null)).toBe(0);
  });
});

describe('a request to fix what a page check found', () => {
  it('names the page and the width, and lists each finding with where it is', () => {
    expect(fixPageRequest(check())).toBe(
      ['Fix what the page check found on http://localhost:5173/ (laid out 390 px wide):', '- A picture with no alt text. At img.hero ("hero.jpg")', '- The page has no title.'].join('\n')
    );
  });

  it('lists no more than its limit, and counts the rest with what the check itself left out', () => {
    const many = check({ findings: [finding({ selector: 'img.a' }), finding({ selector: 'img.b' }), finding({ selector: 'img.c' })], more: 4 });
    expect(fixPageRequest(many, 2)).toBe(
      ['Fix what the page check found on http://localhost:5173/ (laid out 390 px wide):', '- A picture with no alt text. At img.a ("hero.jpg")', '- A picture with no alt text. At img.b ("hero.jpg")', '…and 5 more.'].join('\n')
    );
  });
});
