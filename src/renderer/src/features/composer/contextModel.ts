import type { ContextPart } from '@shared/schemas/sessions';
import { formatTokenCount } from '../../lib/format';

export interface PartBar {
  id: string;
  label: string;
  /** The part's size as the popover writes it ("22K"). */
  tokens: string;
  /** The bar's length, 0..1 of the largest part. */
  share: number;
}

/**
 * The parts of the context as bars, each drawn against the largest: what
 * matters is which part is big, not how they add up. A part that is there at
 * all gets a sliver, so no row looks empty.
 */
export function partBars(parts: ContextPart[]): PartBar[] {
  const largest = Math.max(0, ...parts.map((part) => part.tokens));
  return parts.map((part) => ({
    id: part.id,
    label: part.label,
    tokens: formatTokenCount(part.tokens),
    share: largest > 0 && part.tokens > 0 ? Math.max(0.01, Math.round((part.tokens / largest) * 100) / 100) : 0
  }));
}
