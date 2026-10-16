import { randomUUID, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import type { RuntimeEventsSettings } from '#platform/index.js';
import { RuntimeEventsQueue } from './events-queue.js';
import { RuntimeEventsError, runtimeEventsQuerySchema, runtimeEventsRecordSchema, runtimeEventsKey, type RuntimeEventsSelection, type RuntimeObservationSource,
  type RuntimeObservationRow, type RuntimeEventsRecord, type RuntimeEventsCursor, type RuntimeEventsItem, type RuntimeEventsCloseReason } from './events-contract.js';
export interface RuntimeEventsAdmission {
  readonly binding: string; readonly principalKey: string;
  readonly allows: (row: RuntimeObservationRow) => Promise<boolean>;
}
export interface RuntimeEventsPorts {
  authorize(query: RuntimeEventsSelection, credential?: unknown): Promise<RuntimeEventsAdmission>;
  open(query: RuntimeEventsSelection, admission: RuntimeEventsAdmission): Promise<RuntimeObservationSource>;
  now(): number;
  wallNow(): number;
}
export interface RuntimeEventsSubscription { readonly items: AsyncIterable<RuntimeEventsItem>; close(reason?: RuntimeEventsCloseReason): void }
type Change = Extract<RuntimeEventsItem, { type: 'change' }>;
type Subscriber = { readonly queue: RuntimeEventsQueue; token(): RuntimeEventsCursor; close(reason: RuntimeEventsCloseReason): void };
type View = { readonly id: string; readonly previousId: string | null; readonly credential: unknown; readonly query: RuntimeEventsSelection; readonly admission: RuntimeEventsAdmission;
  readonly source: RuntimeObservationSource; readonly controller: AbortController; readonly subscribers: Set<Subscriber>;
  rows: Map<string, RuntimeObservationRow>; ring: Change[]; ringBytes: number; sequence: number; touched: number; observedAt: number; done: Promise<void> | null; closed: boolean };
/** The sole owner of observation order, per-binding cursors and snapshot barriers. It owns no execution cancellation port. */
export class RuntimeEventsApplication {
  private readonly epoch = randomUUID();
  // Ephemeral cursor-binding key, never an execution capability, credential or durable archive key.
  private readonly resumeKey = randomBytes(32);
  private signView(binding: string, nonce: string): string { return createHmac('sha256', this.resumeKey).update(JSON.stringify([binding, nonce])).digest('hex'); }
  private newViewId(binding: string): string { const nonce = randomUUID(); return nonce + '.' + this.signView(binding, nonce); }
  private ownView(binding: string, value: string): boolean { const [nonce, signature, extra] = value.split('.'); return !extra && !!nonce && !!signature && /^[a-f0-9]{64}$/.test(signature) && timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(this.signView(binding, nonce), 'hex')); }
  private readonly views = new Map<string, Promise<View>>();
  private readonly subscribers = new Set<Subscriber>();
  private readonly principalCounts = new Map<string, number>();
  private readonly scopes = new Map<string, number>();
  private hydrations = 0;
  private readonly hydrationWaiters: (() => void)[] = [];
  private accepting = true;
  private admissionTail: Promise<void> = Promise.resolve();
  constructor(private readonly limits: RuntimeEventsSettings, private readonly ports: RuntimeEventsPorts) {}
  private token(view: View): RuntimeEventsCursor { return { serviceEpoch: this.epoch, viewId: view.id, sequence: view.sequence }; }
  async subscribe(input: unknown, signal?: AbortSignal, credential?: unknown): Promise<RuntimeEventsSubscription> {
    const parsed = runtimeEventsQuerySchema.safeParse(input);
    if (!parsed.success) throw new RuntimeEventsError('RUNTIME_EVENTS_INVALID');
    const query = { ...parsed.data, topics: [...parsed.data.topics].sort() };
    if (!this.accepting || !this.limits.enabled || signal?.aborted) throw new RuntimeEventsError('RUNTIME_EVENTS_UNAVAILABLE');
    const admission = await this.ports.authorize(query, credential); // All topic collection checks precede any frame or source open.
    if (!this.accepting || signal?.aborted) throw new RuntimeEventsError('RUNTIME_EVENTS_UNAVAILABLE');
    const principalCount = this.principalCounts.get(admission.principalKey) ?? 0;
    if (this.subscribers.size >= this.limits.maxSubscribers || principalCount >= this.limits.maxSubscribersPerPrincipal) throw new RuntimeEventsError('RUNTIME_EVENTS_LIMIT');

    // Reserve before awaits, so concurrent admission cannot overbook global capacity.
    let view: View | undefined;
    let safe: RuntimeEventsCursor | null = null;
    const queue = new RuntimeEventsQueue(this.limits.subscriberMaxEvents, this.limits.subscriberMaxBytes,
      () => safe ?? (view ? { ...this.token(view), sequence: 0 } : { serviceEpoch: this.epoch, viewId: this.epoch, sequence: 0 }));
    this.principalCounts.set(admission.principalKey, principalCount + 1);
    let closed = false;
    const subscriber: Subscriber = { queue, token: () => safe ?? (view ? { ...this.token(view), sequence: 0 } : { serviceEpoch: this.epoch, viewId: this.epoch, sequence: 0 }), close: reason => {
      if (closed) return; closed = true;
      queue.close({ type: 'close', reason, resume: subscriber.token() });
      this.subscribers.delete(subscriber);
      const count = (this.principalCounts.get(admission.principalKey) ?? 1) - 1;
      if (count) this.principalCounts.set(admission.principalKey, count); else this.principalCounts.delete(admission.principalKey);
      signal?.removeEventListener('abort', abort);
      if (view) {
        view.subscribers.delete(subscriber); view.touched = this.ports.now();
        if (!view.subscribers.size) { view.controller.abort(); view.closed = true; view.source.close(); if (!view.done) this.releaseScope(view.query.scopeId); }
      }
    } };
    const abort = () => subscriber.close('cancelled');
    this.subscribers.add(subscriber); signal?.addEventListener('abort', abort, { once: true });
    try {
      view = await this.obtain(query, admission, credential);
      if (closed || !this.accepting || signal?.aborted) { if (!view.subscribers.size) { view.controller.abort(); view.source.close(); view.closed = true; this.releaseScope(view.query.scopeId); } subscriber.close('cancelled'); throw new RuntimeEventsError('RUNTIME_EVENTS_UNAVAILABLE'); }
      view.subscribers.add(subscriber);
      const current = view;
      // Freeze the exact barrier now; later producer changes are queued, including while the snapshot is sent.
      const barrier = this.token(current), records = [...current.rows.values()].map(row => row.record);
      const resume = query.resume; let gap: Extract<RuntimeEventsItem, { type: 'gap' }> | null = null;
      let replay: Change[] | null = null;
      if (resume) {
        if (resume.serviceEpoch !== this.epoch) gap = { type: 'gap', reason: 'epoch-changed', resume: barrier, requiresSnapshot: true, missing: null };
        else if (resume.viewId === current.previousId) gap = { type: 'gap', reason: 'source-loss', resume: barrier, requiresSnapshot: true, missing: null };
        else if (resume.viewId !== current.id) {
          if (!this.ownView(admission.binding, resume.viewId)) throw new RuntimeEventsError('RUNTIME_EVENTS_CURSOR');
          gap = { type: 'gap', reason: 'retention', resume: barrier, requiresSnapshot: true, missing: null };
        }
        else if (resume.sequence > barrier.sequence) throw new RuntimeEventsError('RUNTIME_EVENTS_CURSOR');
        else if (resume.sequence < (current.ring[0]?.resume.sequence ?? barrier.sequence + 1) - 1) gap = { type: 'gap', reason: 'retention', resume: barrier, requiresSnapshot: true, missing: null };
        else replay = current.ring.filter(item => item.resume.sequence > resume.sequence);
      }
      safe = replay && query.resume ? query.resume : { ...barrier, sequence: 0 };
      queue.validate();
      if (!replay && !gap && records.some(record => record.sourceLoss)) gap = { type: 'gap', reason: 'source-loss', resume: barrier, requiresSnapshot: true, missing: null };
      if (!current.done) current.done = this.pump(current);
      const authorizeFresh = () => this.ports.authorize(query, credential);
      const epoch = this.epoch, currentToken = () => this.token(current);
      return { close: reason => subscriber.close(reason ?? 'cancelled'), items: (async function* () {
        const fresh = async () => {
          if (closed) return false;
          try { if ((await authorizeFresh()).binding === admission.binding) return true; } catch { /* fail closed */ }
          subscriber.close('authorization-changed'); return false;
        };
        async function* snapshot(data: readonly RuntimeEventsRecord[], at: RuntimeEventsCursor) {
          const snapshotId = randomUUID();
          yield { type: 'snapshot.begin' as const, snapshotId };
          for (const record of data) yield { type: 'snapshot.part' as const, snapshotId, record };
          yield { type: 'snapshot.end' as const, snapshotId, resume: at };
        }
        try {
          const initial: AsyncIterable<RuntimeEventsItem> = (async function* () {
            yield { type: 'ready', scopeId: query.scopeId, topics: query.topics, serviceEpoch: epoch, viewId: current.id, mode: 'observation-order' };
            if (gap) yield gap;
            if (replay) yield* replay; else yield* snapshot(records, barrier);
          })();
          for await (const item of initial) { if (!(await fresh())) break; yield item; if (item.type === 'snapshot.end' || item.type === 'change') safe = item.resume; }
          while (true) {
            const item = await queue.next(); if (!item) return;
            if (item.type === 'close') { yield { ...item, resume: subscriber.token() }; return; }
            if (!(await fresh())) continue;
            yield item.type === 'gap' ? { ...item, resume: subscriber.token() } : item;
            if (item.type === 'change') safe = item.resume;
            if (item.type === 'gap') {
              // Capture is the producer's current immutable map/cursor, with no await between barrier and queue reset.
              const at = currentToken(), data = [...current.rows.values()].map(row => row.record); queue.reset();
              for await (const part of snapshot(data, at)) { if (!(await fresh())) break; yield part; if (part.type === 'snapshot.end') safe = part.resume; }
            }
          }
        } finally { subscriber.close('cancelled'); }
      })() };
    } catch (error) { subscriber.close('source-unavailable'); throw error; }
  }
  private async obtain(query: RuntimeEventsSelection, admission: RuntimeEventsAdmission, credential: unknown): Promise<View> {
    const prior = this.admissionTail; let release!: () => void;
    this.admissionTail = new Promise<void>(resolve => { release = resolve; });
    await prior;
    try { return await this.obtainSerial(query, admission, credential); } finally { release(); }
  }
  private async obtainSerial(query: RuntimeEventsSelection, admission: RuntimeEventsAdmission, credential: unknown): Promise<View> {
    let previousId: string | null = null;
    for (const [key, promised] of this.views) {
      const v = await promised;
      if (v.closed && this.ports.now() - v.touched >= this.limits.resumeTtlMs && key !== admission.binding) this.views.delete(key);
    }
    const existing = this.views.get(admission.binding);
    if (existing) {
      const view = await existing;
      if (!view.closed) return view;
      // No observer means no collector; a new capture has a new view lineage, never fictitious continuity.
      previousId = view.id; this.views.delete(admission.binding);
      if (query.resume?.serviceEpoch === this.epoch && query.resume.viewId === view.id) query = { ...query, resume: null };
    }
    if (this.views.size >= this.limits.maxViews || (!this.scopes.has(query.scopeId) && this.scopes.size >= this.limits.maxObservedScopes)) throw new RuntimeEventsError('RUNTIME_EVENTS_LIMIT');
    this.scopes.set(query.scopeId, (this.scopes.get(query.scopeId) ?? 0) + 1);
    const created = (async (): Promise<View> => {
      const source = await this.ports.open(query, admission), controller = new AbortController();
      const view: View = { id: this.newViewId(admission.binding), previousId, credential, query, admission, source, controller, subscribers: new Set(), rows: new Map(), ring: [], ringBytes: 0,
        sequence: 0, touched: this.ports.now(), observedAt: this.ports.wallNow(), done: null, closed: false };
      try { view.rows = await this.capture(view); if (!this.accepting) { view.closed = true; source.close(); controller.abort(); throw new RuntimeEventsError('RUNTIME_EVENTS_UNAVAILABLE'); } return view; }
      catch (error) { source.close(); throw error; }
    })();
    this.views.set(admission.binding, created);
    try { return await created; } catch (error) { this.views.delete(admission.binding); this.releaseScope(query.scopeId); throw error; }
  }
  private releaseScope(scopeId: string): void { const n = (this.scopes.get(scopeId) ?? 1) - 1; if (n) this.scopes.set(scopeId, n); else this.scopes.delete(scopeId); }
  private async capture(view: View): Promise<Map<string, RuntimeObservationRow>> {
    if (this.hydrations >= this.limits.maxConcurrentHydrations) await new Promise<void>(resolve => { this.hydrationWaiters.push(resolve); });
    else this.hydrations++;
    try {
      if (view.controller.signal.aborted) throw new RuntimeEventsError('RUNTIME_EVENTS_UNAVAILABLE');
      return await this.captureBounded(view);
    } finally { const wake = this.hydrationWaiters.shift(); if (wake) wake(); else this.hydrations--; }
  }
  private async captureBounded(view: View): Promise<Map<string, RuntimeObservationRow>> {
    const deadline = this.ports.now() + this.limits.snapshotDeadlineMs;
    let captured = await view.source.capture(view.controller.signal);
    for (let retry = 0; captured.sourceLoss && retry < this.limits.snapshotRetryLimit && this.ports.now() < deadline; retry++) {
      await view.source.wait(view.controller.signal); captured = await view.source.capture(view.controller.signal);
    }
    if (captured.sourceLoss) throw new RuntimeEventsError('RUNTIME_EVENTS_UNAVAILABLE');
    const rows = new Map<string, RuntimeObservationRow>(); let bytes = 0;
    for (const row of captured.rows) {
      if (view.controller.signal.aborted || this.ports.now() > deadline) throw new RuntimeEventsError('RUNTIME_EVENTS_LIMIT');
      if (!(await view.admission.allows(row))) continue;
      const record = runtimeEventsRecordSchema.parse(row.record);
      bytes += Buffer.byteLength(JSON.stringify(record));
      if (rows.size >= this.limits.maxSnapshotRows || bytes > this.limits.maxSnapshotBytes) throw new RuntimeEventsError('RUNTIME_EVENTS_TOO_LARGE');
      rows.set(runtimeEventsKey(record), { ...row, record });
    }
    view.observedAt = this.ports.wallNow(); return rows;
  }
  private publish(view: View, operation: Change['operation'], row: RuntimeObservationRow): void {
    view.sequence++;
    const item: Change = { type: 'change', operation, record: row.record, resume: this.token(view) };
    const bytes = Buffer.byteLength(JSON.stringify(item)); view.ring.push(item); view.ringBytes += bytes;
    while (view.ring.length > this.limits.viewReplayMaxEvents || view.ringBytes > this.limits.viewReplayMaxBytes) {
      view.ringBytes -= Buffer.byteLength(JSON.stringify(view.ring.shift()));
    }
    for (const subscriber of view.subscribers) subscriber.queue.push(item);
  }
  private async pump(view: View): Promise<void> {
    let heartbeatAt = this.ports.now();
    try {
      while (!view.controller.signal.aborted) {
        await view.source.wait(view.controller.signal);
        if (view.controller.signal.aborted) break;
        let authorized = false;
        try { authorized = (await this.ports.authorize(view.query, view.credential)).binding === view.admission.binding; } catch { /* policy/config/key unavailable is closed */ }
        if (!authorized) { for (const s of [...view.subscribers]) s.close('authorization-changed'); break; }
        const next = await this.capture(view); let sourceLoss = false;
        for (const [key, row] of next) {
          const old = view.rows.get(key);
          if (!old || old.watermark !== row.watermark || old.record.status !== row.record.status) {
            if (row.record.sourceLoss || (old && row.record.revision > old.record.revision + 1)) sourceLoss = true;
            this.publish(view, 'upsert', row);
          }
        }
        for (const [key, row] of view.rows) if (!next.has(key)) { sourceLoss = true; this.publish(view, 'remove', row); }
        view.rows = next;
        if (sourceLoss) for (const s of view.subscribers) s.queue.push({ type: 'gap', reason: 'source-loss', resume: s.token(), requiresSnapshot: true, missing: null });
        if (this.ports.now() - heartbeatAt >= this.limits.heartbeatMs) {
          heartbeatAt = this.ports.now();
          for (const s of view.subscribers) s.queue.push({ type: 'heartbeat', resume: this.token(view), observedAt: view.observedAt, freshness: [...view.rows.values()].some(row => row.record.status === 'unavailable') ? 'unavailable' : 'current' });
        }
      }
    } catch {
      for (const s of [...view.subscribers]) s.close('source-unavailable');
    } finally { view.source.close(); view.closed = true; this.releaseScope(view.query.scopeId); }
  }
  /** Stop admission immediately. Subscribers drain a reason without holding any control/execution slot. */
  async stop(): Promise<void> {
    this.accepting = false;
    for (const subscriber of [...this.subscribers]) subscriber.close('service-shutdown');
    const views = await Promise.allSettled(this.views.values());
    await Promise.all(views.flatMap(value => value.status === 'fulfilled' ? [value.value.done] : []));
    this.views.clear(); this.scopes.clear(); this.resumeKey.fill(0);
  }
}
