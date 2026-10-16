import type { RuntimeEventsSettings } from '#platform/index.js';
import { RuntimeEventsError, type RuntimeEventsAdmission, type RuntimeObservationCapture, type RuntimeObservationRow, type RuntimeObservationSource } from '#engine/core/runtime/index.js';
/** Watch installed before capture; the dirty bit closes watch-before-wait races. Timer reconciles coalesced/missed notifications. */
export async function openRuntimeObservationSource(admission: RuntimeEventsAdmission, limits: RuntimeEventsSettings, ports: {
  watch(notify: () => void): { close(): void; on(event: 'error', notify: () => void): void };
  open(): { capture(now: number): RuntimeObservationCapture; close(): void };
  live(row: RuntimeObservationRow): Promise<{ watermark: string; eventCount: number; inputTokens: number; outputTokens: number; sourceLoss: boolean }>;
}): Promise<RuntimeObservationSource> {
  let dirty = false, closed = false, wake: (() => void) | null = null;
  const watcher = ports.watch( () => { dirty = true; wake?.(); });
  watcher.on('error', () => { dirty = true; wake?.(); });
  let reader: ReturnType<typeof ports.open>;
  try { reader = ports.open(); } catch (error) { watcher.close(); throw error; }
  const previous = new Map<string, string>();
  return {
    async capture(signal) {
      if (closed || signal.aborted) throw new RuntimeEventsError('RUNTIME_EVENTS_UNAVAILABLE');
      const capture = reader.capture(Date.now()), rows: RuntimeObservationRow[] = [];
      // Sequential bounded hydrations: no worker process, socket, or unbounded queue is started.
      for (const row of capture.rows) {
        if (signal.aborted) throw new RuntimeEventsError('RUNTIME_EVENTS_UNAVAILABLE');
        if (!(await admission.allows(row))) continue;
        if (!row.workspace || row.record.topic !== 'worker') { rows.push(row); continue; }
        try {
          const live = await ports.live(row);
          const last = previous.get(row.record.id), [device, inode, size] = live.watermark.split(':');
          const [oldDevice, oldInode, oldSize] = last?.split(':') ?? [];
          const rotated = last !== undefined && (oldDevice !== device || oldInode !== inode || Number(oldSize) > Number(size));
          previous.set(row.record.id, live.watermark);
          rows.push({ ...row, watermark: `${row.watermark}:${live.watermark}`, record: { ...row.record, evidence: 'worker-reported',
            eventCount: live.eventCount, inputTokens: live.inputTokens, outputTokens: live.outputTokens, sourceLoss: live.sourceLoss || rotated } });
        } catch {
          rows.push({ ...row, watermark: `${row.watermark}:unavailable`, record: { ...row.record, status: 'unavailable', evidence: 'unknown', sourceLoss: true } });
        }
      }
      const ids = new Set(rows.map(row => row.record.id)); for (const id of previous.keys()) if (!ids.has(id)) previous.delete(id);
      return { ...capture, rows };
    },
    wait(signal) {
      if (dirty || closed || signal.aborted) { dirty = false; return Promise.resolve(); }
      return new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); wake = null; dirty = false; resolve(); };
        const timer = setTimeout(finish, Math.min(limits.reconcileIntervalMs, limits.authorizationRefreshMs, limits.liveWorkerFlushMs));
        wake = finish; signal.addEventListener('abort', finish, { once: true });
      });
    },
    close() { if (!closed) { closed = true; watcher.close(); reader.close(); wake?.(); } },
  };
}
