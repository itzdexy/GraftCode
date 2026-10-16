import { describe, expect, it } from 'vitest';
import { mathToDollars } from '../../../src/renderer/src/features/session/mathModel';

const same = (text: string): void => expect(mathToDollars(text), text).toEqual({ text, math: false });

describe('math in a reply', () => {
  it('is read in each way models write it', () => {
    expect(mathToDollars('Euler: $e^{i\\pi} + 1 = 0$.')).toEqual({ text: 'Euler: $$e^{i\\pi} + 1 = 0$$.', math: true });
    expect(mathToDollars('so \\(a+b\\) holds')).toEqual({ text: 'so $$a+b$$ holds', math: true });
    expect(mathToDollars('a\n\\[\nx^2\n\\]\nb')).toEqual({ text: 'a\n\n$$\nx^2\n$$\n\nb', math: true });
    expect(mathToDollars('$$\nx = 1\n$$')).toEqual({ text: '$$\nx = 1\n$$', math: true });
    expect(mathToDollars('$x$ and $n$, then $O(n)$ and $x_i$')).toEqual({ text: '$$x$$ and $$n$$, then $$O(n)$$ and $$x_i$$', math: true });
    expect(mathToDollars('costs $5; let $x_1 = 2$')).toEqual({ text: 'costs $5; let $$x_1 = 2$$', math: true });
  });

  it('sets a formula that stands alone on its line as a display, however it was fenced', () => {
    expect(mathToDollars('so:\n\\[ E = mc^2 \\]\nand on')).toEqual({ text: 'so:\n\n$$\nE = mc^2\n$$\n\nand on', math: true });
    expect(mathToDollars('so:\n$$ E = mc^2 $$\nand on')).toEqual({ text: 'so:\n\n$$\nE = mc^2\n$$\n\nand on', math: true });
    expect(mathToDollars('\\[\na &= b \\\\\n  c &= d\n\\]')).toEqual({ text: '$$\na &= b \\\\\nc &= d\n$$', math: true });
    // In a list item the display keeps the item's indent, so it stays part of the item.
    expect(mathToDollars('- then:\n  \\[\n  x^2\n  \\]\n- next')).toEqual({ text: '- then:\n\n  $$\n  x^2\n  $$\n\n- next', math: true });
    // In the middle of a sentence it stays in the sentence.
    expect(mathToDollars('so $$x = 1$$ holds')).toEqual({ text: 'so $$x = 1$$ holds', math: true });
  });

  it('leaves money and shell variables alone', () => {
    for (const text of ['It costs $5 and $10.', '$5-$10', 'from $5M to $10M', 'costs $5,$6', '$HOME/$USER', '$PATH:$HOME', 'a $ b $ c', 'echo $1 and $2', 'US$20 to US$30', 'paid \\$5 for $x', 'a\\$b^2\\$c']) same(text);
  });

  it('leaves code and unfinished math alone', () => {
    same('`$x^2$` and\n```\n$y_1$\n\\(z\\)\n```');
    same('so $$x = 1');
    same('so \\[ x = 1');
    same('~~~\n\\[ a \\]\n~~~');
    same('``a $x^2$ ` b`` and `c');
    same('so \\(a+b holds');
    same('\\[\nx\n\n\\]');
  });

  it('marks a fence that never closes as text once there is other math, so it cannot swallow what follows', () => {
    expect(mathToDollars('$x_1$ then\n$$ never closed')).toEqual({ text: '$$x_1$$ then\n\\$\\$ never closed', math: true });
  });

  it('leaves escaped brackets in a sentence alone', () => {
    for (const text of ['see \\[1\\] and \\[2\\]', '\\[1\\] Smith 2020', 'call it \\(\\) twice', 'arr\\[0\\] = 1']) same(text);
  });

  it('reads math after code on the same line, and on the lines around a fence', () => {
    expect(mathToDollars('`a$b` then $x^2$')).toEqual({ text: '`a$b` then $$x^2$$', math: true });
    expect(mathToDollars('$a_1$\n```\n$b_1$\n```\n$c_1$')).toEqual({ text: '$$a_1$$\n```\n$b_1$\n```\n$$c_1$$', math: true });
  });
});
