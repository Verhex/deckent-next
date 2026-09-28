/**
 * The one owner of the scratch resource inside the service (Astra 2149): who may open, measure, remove and write an area. One
 * instance per service (the start sweep, the periodic sweep and every turn share it); the ledger custody makes that one service per
 * ledger, so no other process writes or removes areas through Deckent.
 *
 * Areas (`<owner>/<session>`, and the owner directory `<owner>`): a turn `hold`s its area before the area is opened, waiting while a
 * removal of it (or of its owner directory) is in flight; the sweep `claim`s an area before it measures it and keeps the claim until
 * the removal ended, so a held area is never removed and a removed area is never opened half-way. `close` (service stop) refuses
 * every later claim and settles once the removals in flight ended: nothing is removed after the endpoint custody is released.
 *
 * Writes: one exclusive lane per custody (the service's one scratch resource) — measure the budgets, write, release — so two writes
 * never spend the same free bytes, whatever their sessions; the lane is handed on whatever the outcome, and the next write measures
 * what the disk then holds (an unknown outcome is never counted twice nor lost).
 */
export interface ScratchActivity {
  /** Holds the area `key` (counted; its owner directory is held too) once no removal of it is in flight; resolves with the release. */
  hold(key: string): Promise<() => void>;
  /** Whether a running turn holds `key` (an area, or an owner directory through any of its areas). */
  has(key: string): boolean;
  /** The removal custody of `key` for the sweep; null when it is held, already being removed, or the custody is closed. */
  claim(key: string): (() => void) | null;
  /** The write lane: resolves with its release once every earlier write released it; an abort while waiting leaves the queue. */
  lane(signal?: AbortSignal): Promise<() => void>;
  /** Service stop: no claim succeeds any more; settles when the removals in flight ended. */
  close(): Promise<void>;
}

interface AreaState { holds: number; removing: Promise<void> | null }
const once = (action: () => void) => { let done = false; return () => { if (!done) { done = true; action(); } }; };
const ownerOf = (key: string) => key.split('/')[0]!;

export function createScratchActivity(): ScratchActivity {
  const areas = new Map<string, AreaState>(), removals = new Set<Promise<void>>();
  const state = (key: string) => { let found = areas.get(key); if (!found) { found = { holds: 0, removing: null }; areas.set(key, found); } return found; };
  const settle = (key: string) => { const found = areas.get(key); if (found && found.holds === 0 && !found.removing) areas.delete(key); };
  let closed = false, laneBusy = false;
  const waiting: { readonly grant: () => void }[] = [];
  const handOn = () => { const next = waiting.shift(); if (next) next.grant(); else laneBusy = false; };
  return Object.freeze({
    async hold(key: string) {
      const keys = key.includes('/') ? [ownerOf(key), key] : [key];
      for (;;) {
        const busy = keys.map(part => areas.get(part)?.removing).find(Boolean);
        if (!busy) break;
        await busy;
      }
      for (const part of keys) state(part).holds++;
      return once(() => { for (const part of keys) { state(part).holds--; settle(part); } });
    },
    has: (key: string) => (areas.get(key)?.holds ?? 0) > 0,
    claim(key: string) {
      const found = areas.get(key);
      if (closed || (found && (found.holds > 0 || found.removing))) return null;
      let finish!: () => void;
      const removing = new Promise<void>(resolve => { finish = resolve; });
      state(key).removing = removing; removals.add(removing);
      return once(() => { state(key).removing = null; removals.delete(removing); settle(key); finish(); });
    },
    lane(signal?: AbortSignal) {
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (!laneBusy) { laneBusy = true; return Promise.resolve(once(handOn)); }
      return new Promise<() => void>((resolve, reject) => {
        const entry = { grant: () => { signal?.removeEventListener('abort', leave); resolve(once(handOn)); } };
        const leave = () => { const at = waiting.indexOf(entry); if (at >= 0) waiting.splice(at, 1); reject(signal!.reason); };
        waiting.push(entry);
        signal?.addEventListener('abort', leave, { once: true });
      });
    },
    async close() { closed = true; await Promise.all([...removals]); },
  });
}
