import { RuntimeEventsError, type RuntimeEventsCursor, type RuntimeEventsItem } from './events-contract.js';
/** Producer never awaits a subscriber. Overflow keeps a reserved gap, discarding all unsent stale data. */
export class RuntimeEventsQueue {
  private items: RuntimeEventsItem[] = [];
  private bytes = 0;
  private wake: (() => void) | null = null;
  private ended = false;
  private gap = false;
  constructor(private readonly maxEvents: number, private readonly maxBytes: number, private readonly token: () => RuntimeEventsCursor) {
    if (maxEvents < 2 || maxBytes < this.reserveBytes()) throw new RuntimeEventsError('RUNTIME_EVENTS_TOO_LARGE');
  }
  validate(): void { if (this.maxBytes < this.reserveBytes()) throw new RuntimeEventsError('RUNTIME_EVENTS_TOO_LARGE'); }
  private overflow(): RuntimeEventsItem { return { type: 'gap', reason: 'overflow', resume: this.token(), requiresSnapshot: true, missing: null }; }
  private reserveBytes(): number { return Buffer.byteLength(JSON.stringify(this.overflow())) + Buffer.byteLength(JSON.stringify({ type: 'close', reason: 'authorization-changed', resume: this.token() })); }
  push(item: RuntimeEventsItem): void {
    if (this.ended || this.gap) return;
    const bytes = Buffer.byteLength(JSON.stringify(item));
    if (this.items.length >= this.maxEvents - 1 || this.bytes + bytes > this.maxBytes - this.reserveBytes()) {
      this.items = [this.overflow()]; this.bytes = Buffer.byteLength(JSON.stringify(this.items[0])); this.gap = true;
    } else { this.items.push(item); this.bytes += bytes; }
    this.wake?.(); this.wake = null;
  }
  /** The consumer captured a new barrier; pending changes covered by it no longer need delivery. */
  reset(): void { if (this.ended) return; this.items = []; this.bytes = 0; this.gap = false; }
  close(item: RuntimeEventsItem): void {
    if (this.ended) return;
    this.ended = true; this.items = [item]; this.bytes = Buffer.byteLength(JSON.stringify(item)); this.wake?.(); this.wake = null;
  }
  async next(): Promise<RuntimeEventsItem | null> {
    while (!this.items.length && !this.ended) await new Promise<void>(resolve => { this.wake = resolve; });
    const item = this.items.shift();
    if (item) this.bytes -= Buffer.byteLength(JSON.stringify(item));
    return item ?? null;
  }
}
