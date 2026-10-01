/**
 * Terminal output arrives as chunks tagged with their stream offset, and a
 * reopened terminal starts from a scrollback snapshot that ends at a known
 * offset. These helpers merge the two without gaps or duplicates.
 */

/** The part of a chunk starting at `offset` that lies after stream position `end`. */
export function sliceAfter(data: string, offset: number, end: number): string {
  if (offset + data.length <= end) return '';
  if (offset >= end) return data;
  return data.slice(end - offset);
}

export class StreamJoiner {
  private end: number | null = null;
  private readonly early: Array<{ data: string; offset: number }> = [];

  constructor(private readonly write: (data: string) => void) {}

  /** A chunk from the live stream. Buffered until the snapshot has been applied. */
  chunk(data: string, offset: number): void {
    if (this.end === null) {
      this.early.push({ data, offset });
      return;
    }
    const fresh = sliceAfter(data, offset, this.end);
    if (fresh.length > 0) {
      this.write(fresh);
      this.end = offset + data.length;
    }
  }

  /** Applies the snapshot, then any chunks that arrived while it was loading. */
  snapshot(data: string, end: number): void {
    this.write(data);
    this.end = end;
    for (const c of this.early.splice(0)) this.chunk(c.data, c.offset);
  }
}
