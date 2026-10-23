/** One memoized read: `keep` false (a transient failure folded into the value) answers this call but is not kept for the next one. */
export type MonitorRecall = <T>(key: string, compute: () => Promise<T>, keep?: (value: T) => boolean) => Promise<T>;
/** No memo at all (a single standalone read): every recall computes. */
export const readThrough: MonitorRecall = (_key, compute) => compute();

/**
 * MON-CPU-FIX (owner A48-D10, 2026-10-19): the live monitor's memo of ledger-, policy- and config-derived reads, held by one monitor view.
 * Each inspection of a target names one generation (the viewer and the stamps of the target's sources); a different generation drops every
 * earlier entry, so nothing is answered from another viewer's or an older source's read. Live sources (process activity, worker sidecars,
 * resource traces, model availability) are never recalled. Bounded without a number: an inspection keeps only the keys it touched, so the
 * memo never holds more than one inspection's ledger working set per target. A failed compute is never kept.
 */
export class MonitorSourceMemo {
  private readonly targets = new Map<string, { readonly generation: string; readonly entries: Map<string, Promise<unknown>> }>();
  /** The recall for one inspection of `target`. `null` (no memo across reads, or sources unknown or changed too recently to trust their stamps)
   * shares reads within this inspection only and forgets the target. */
  recall(target: string, generation: string | null): MonitorRecall {
    const previous = this.targets.get(target), entries = new Map<string, Promise<unknown>>();
    const kept = generation !== null && previous?.generation === generation ? previous.entries : new Map<string, Promise<unknown>>();
    if (generation === null) this.targets.delete(target); else this.targets.set(target, { generation, entries });
    return <T>(key: string, compute: () => Promise<T>, keep?: (value: T) => boolean): Promise<T> => {
      const known = (entries.get(key) ?? kept.get(key)) as Promise<T> | undefined;
      if (known) { entries.set(key, known); return known; }
      const value = compute(), forget = () => { if (entries.get(key) === value) entries.delete(key); };
      entries.set(key, value); value.then(result => { if (keep && !keep(result)) forget(); }, forget);
      return value;
    };
  }
}
