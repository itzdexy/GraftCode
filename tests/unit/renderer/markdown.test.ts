import { describe, expect, it } from 'vitest';
import { isCitation, tidyMarkdown } from '../../../src/renderer/src/features/session/Markdown';

describe('markdown repairs', () => {
  it('splits a table header glued to the heading before it, so the table renders', () => {
    const broken = ['### The lineup| Model | Status | Positioning |', '|---|---|---|', '| **Mythos 5.1** | Trusted access only | Same model |', '| **Fable 5.1** | GA | Frontier |'].join('\n');
    expect(tidyMarkdown(broken).split('\n')).toEqual([
      '### The lineup',
      '',
      '| Model | Status | Positioning |',
      '|---|---|---|',
      '| **Mythos 5.1** | Trusted access only | Same model |',
      '| **Fable 5.1** | GA | Frontier |'
    ]);
  });

  it('gives a table right after a paragraph line its own block, and leaves code and good tables alone', () => {
    expect(tidyMarkdown('Here they are:\n| a | b |\n|---|---|\n| 1 | 2 |')).toBe('Here they are:\n\n| a | b |\n|---|---|\n| 1 | 2 |');
    const fine = '## Plans\n\n| a | b |\n| :-- | --: |\n| 1 | 2 |';
    expect(tidyMarkdown(fine)).toBe(fine);
    const code = '```\nx| a | b |\n|---|---|\n```';
    expect(tidyMarkdown(code)).toBe(code);
    // A pipe in prose with a column count that doesn't match is not a table header.
    expect(tidyMarkdown('a | b\n|---|---|---|')).toBe('a | b\n|---|---|---|');
  });

  it('drops parentheses around a lone citation link', () => {
    expect(tidyMarkdown('before launch ([rolimons.com](https://www.rolimons.com/game/rivals)).')).toBe('before launch [rolimons.com](https://www.rolimons.com/game/rivals).');
    expect(tidyMarkdown('see (the [full report](https://x.dev/r))')).toBe('see (the [full report](https://x.dev/r))');
  });

  it('treats links named after their site as citations', () => {
    expect(isCitation('https://www.rolimons.com/game/rivals', 'rolimons.com')).toBe(true);
    expect(isCitation('https://parix.ai/models', 'parix')).toBe(true);
    expect(isCitation('https://cr.linkedin.com/post/1', 'linkedin')).toBe(true);
    expect(isCitation('https://example.com/a', 'the full report')).toBe(false);
    expect(isCitation('https://example.com/a', 'other.org')).toBe(false);
    expect(isCitation('javascript:alert(1)', 'alert')).toBe(false);
  });
});
