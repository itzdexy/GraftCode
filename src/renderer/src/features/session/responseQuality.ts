/** Specific model protocol markers, not a language or prose-quality heuristic. */
const CONTROL_TOKEN = /<\|(?:open|close|im_start|im_end|start|end|message|channel|return|fim_suffix|endoftext)\|>/g;

/** Detect repeated leaked protocol markers outside code, preserving the original answer. */
export function responseHasControlTokens(text: string): boolean {
  let fence: { mark: string; length: number } | null = null;
  let count = 0;
  for (const line of text.split('\n')) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (match?.[1]?.startsWith(fence.mark) && match[1].length >= fence.length && (match[2] ?? '').trim() === '') fence = null;
      continue;
    }
    if (match?.[1]) { fence = { mark: match[1].charAt(0), length: match[1].length }; continue; }
    // Explanations and examples commonly quote tokens as inline code.
    const prose = line.replace(/(`+)[^`]*\1/g, '');
    count += [...prose.matchAll(CONTROL_TOKEN)].length;
    if (count >= 2) return true;
  }
  return false;
}
