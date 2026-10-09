import { describe, expect, it } from 'vitest';
import { responseHasControlTokens } from '../../../src/renderer/src/features/session/responseQuality';

describe('provider control-token guidance', () => {
  it('identifies the screenshot’s repeated raw protocol markers', () => {
    expect(responseHasControlTokens('hello<|close|>think 工作<|open|>response')).toBe(true);
  });
  it('preserves normal multilingual prose and isolated literal tokens without a warning', () => {
    for (const text of ['你好，世界. Hello!', 'A string may contain <|close|>.', '文件 <file Graft', 'The damaged character is �']) expect(responseHasControlTokens(text)).toBe(false);
  });
  it('does not warn for fenced or inline code examples, including long fences', () => {
    for (const text of ['```text\n<|open|><|close|>\n```', '~~~~\n<|open|><|close|>\n~~~\n~~~~', '`<|open|>` and `<|close|>`', '``<|open|><|close|>``']) expect(responseHasControlTokens(text)).toBe(false);
  });
  it('resumes prose detection after a code fence closes and across streaming chunks', () => {
    expect(responseHasControlTokens('```\nexample\n```\n<|open|><|close|>')).toBe(true);
    expect(responseHasControlTokens('<|open|>partial<|cl')).toBe(false);
    expect(responseHasControlTokens('<|open|>partial<|close|>')).toBe(true);
  });
});
