/** Maps every item with at most `limit` calls in flight; results keep input order. For bounded read-only fan-out (observation probes);
 * a rejection rejects the whole map, so callers that must keep going handle each item's failure inside `map`. */
export async function mapBounded<T, R>(items: readonly T[], limit: number, map: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await map(items[index]!, index); }
  }));
  return results;
}
