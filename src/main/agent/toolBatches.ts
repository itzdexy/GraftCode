/**
 * Splits the calls of one response into groups that run one after another:
 * each run of neighbouring calls that may overlap is one group, and every
 * other call is a group of its own. The order of the calls never changes, so
 * a call that follows an edit still runs after it.
 */
export function toBatches<T>(calls: T[], mayOverlap: (call: T) => boolean): T[][] {
  const batches: T[][] = [];
  let open: T[] | null = null;
  for (const call of calls) {
    if (!mayOverlap(call)) {
      open = null;
      batches.push([call]);
    } else if (open) {
      open.push(call);
    } else {
      open = [call];
      batches.push(open);
    }
  }
  return batches;
}
