import type { SurfaceFollowEvent, SurfacePublicationKind } from './surface-follow.js';
/** Publication order and repeated access checks; storage and wake-up ownership stay behind ports. */
export async function* followSurfacePublications(scopeId: string, kinds: readonly SurfacePublicationKind[], ports: {
  fresh(): Promise<boolean>;
  open(): { read(): readonly { readonly kind: SurfacePublicationKind; readonly id: string; readonly missed: number }[]; close(): void };
  wait(signal: AbortSignal): Promise<void>;
}, signal: AbortSignal, onReady?: () => void): AsyncGenerator<SurfaceFollowEvent> {
  if (signal.aborted) return;
  const denied = (['approval', 'run', 'worker'] as const).filter(kind => !kinds.includes(kind));
  if (denied.length) yield { access: 'denied', scopeId, kinds: denied, stopped: kinds.length === 0 };
  if (kinds.length === 0 || signal.aborted) return;
  // A consumer can pause at a denial or publication: recheck before opening and before every subsequent read/yield.
  if (!(await ports.fresh())) { yield { access: 'denied', scopeId, kinds, stopped: true }; return; }
  if (signal.aborted) return;
  const tail = ports.open();
  let closed = false;
  const close = () => { if (!closed) { closed = true; tail.close(); } };
  const sequence = { approval: 0, run: 0, worker: 0 };
  try {
    onReady?.();
    yield { control: 'start', scopeId, cursors: { ...sequence } };
    while (!signal.aborted) {
      if (!(await ports.fresh())) { close(); yield { access: 'denied', scopeId, kinds, stopped: true }; return; }
      if (signal.aborted) return;
      const rows = tail.read();
      if (rows.length === 0) { await ports.wait(signal); continue; }
      for (const row of rows) {
        if (!(await ports.fresh())) { close(); yield { access: 'denied', scopeId, kinds, stopped: true }; return; }
        if (signal.aborted) return;
        sequence[row.kind] += 1 + row.missed;
        yield { kind: row.kind, scopeId, sequence: sequence[row.kind], id: row.id, text: `${row.kind}:${row.id}` };
      }
    }
  } finally { close(); }
}
