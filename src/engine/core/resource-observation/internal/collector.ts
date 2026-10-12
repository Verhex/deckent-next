import type { ResourceObservationSettings } from '#platform/index.js';
import type { SandboxRequest, ExecutionSupervisor } from '#engine/core/supervisor/index.js';
import { resourceGap, validateResourceSample, type ResourceReader, type ResourceSample, type ResourceTraceStore, type ResourceExecutionObserver } from './contract.js';
const MILLISECONDS_PER_SECOND = 1000;
interface QueuedSample { readonly sample: ResourceSample; readonly signal: AbortSignal }

/** One bounded collector owner per service. No launch, settlement or caller awaits trace I/O. */
export class ResourceCollector implements ResourceExecutionObserver {
  private active = 0;
  private writing = false;
  private readonly queue: QueuedSample[] = [];
  private lost: QueuedSample | null = null;
  constructor(private readonly store: ResourceTraceStore, private readonly settings: ResourceObservationSettings,
    private readonly now: () => number = Date.now) {}
  private enqueue(sample: ResourceSample, signal: AbortSignal) {
    if (this.queue.length >= this.settings.maxQueueEntries) { this.lost = { sample: resourceGap(sample.identity, this.now(), 'queue-full', sample.worker), signal }; return; }
    this.queue.push({ sample, signal }); void this.drain();
  }
  private async append(entry: QueuedSample) {
    if (entry.signal.aborted) return;
    const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), this.settings.timeoutMs);
    timer.unref();
    try { await this.store.append(entry.sample, AbortSignal.any([entry.signal, deadline.signal])); }
    finally { clearTimeout(timer); }
  }
  private async drain() {
    if (this.writing) return; this.writing = true;
    try {
      while (this.queue.length) {
        const entry = this.queue.shift()!;
        if (entry.signal.aborted) continue;
        try {
          if (this.lost) { const lost = this.lost; this.lost = null; await this.append(lost); }
          await this.append(entry);
        } catch { if (!entry.signal.aborted) this.lost = { sample: resourceGap(entry.sample.identity, this.now(), 'store-unavailable', entry.sample.worker), signal: entry.signal }; }
      }
    } finally { this.writing = false; }
  }
  private async read(reader: ResourceReader, request: SandboxRequest, worker: ResourceSample['worker'], signal: AbortSignal) {
    this.active++;
    const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), this.settings.timeoutMs);
    timer.unref();
    const combined = AbortSignal.any([signal, deadline.signal]);
    // A non-cooperative reader retains its physical slot until settlement: timeout must not admit unlimited reads.
    const pending = Promise.resolve().then(() => { combined.throwIfAborted(); return reader.readResources(request, worker, this.settings, combined); });
    void pending.then(() => { this.active--; }, () => { this.active--; });
    let aborted!: () => void;
    const canceled = new Promise<never>((_resolve, reject) => { aborted = () => reject(combined.reason); combined.addEventListener('abort', aborted, { once: true }); });
    try { return await Promise.race([pending, canceled]); }
    finally { clearTimeout(timer); combined.removeEventListener('abort', aborted); }
  }
  start(request: SandboxRequest, supervisor: ExecutionSupervisor) {
    if (!this.settings.enabled) return { stop() { /* Disabled observation performs no trace I/O. */ } };
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    let worker: ResourceSample['worker'] = null; let previous: ResourceSample | null = null;
    const reader = supervisor as ExecutionSupervisor & Partial<ResourceReader>;
    const tick = async () => {
      if (controller.signal.aborted) return;
      let sample: ResourceSample;
      if (!this.settings.enabled || !reader.readResources) sample = resourceGap(request.identity, this.now(), this.settings.enabled ? 'unsupported' : 'disabled');
      else if (this.active >= this.settings.maxConcurrentReads) sample = resourceGap(request.identity, this.now(), 'overload', worker);
      else {
        try {
          sample = validateResourceSample(await this.read(reader as ResourceReader, request, worker, controller.signal), request.identity, worker);
          if (!sample.gap && sample.worker) {
            worker = sample.worker;
            if (previous && (sample.observedAtMs <= previous.observedAtMs || (sample.cpuSeconds != null && previous.cpuSeconds != null && sample.cpuSeconds < previous.cpuSeconds))) {
              sample = resourceGap(request.identity, this.now(), 'counter-reset', worker);
            } else if (previous?.cpuSeconds != null && sample.cpuSeconds != null) {
              sample = { ...sample, cpuCores: (sample.cpuSeconds - previous.cpuSeconds) / ((sample.observedAtMs - previous.observedAtMs) / MILLISECONDS_PER_SECOND) };
            }
            previous = sample.gap ? null : sample;
          }
        } catch (error) { sample = resourceGap(request.identity, this.now(), error instanceof Error && error.message === 'RESOURCE_IDENTITY' ? 'identity' : controller.signal.aborted ? 'missing' : 'timeout', worker); }
      }
      if (!controller.signal.aborted) this.enqueue(sample, controller.signal);
      if (!controller.signal.aborted && this.settings.enabled && reader.readResources && sample.gap !== 'unsupported') {
        timer = setTimeout(() => { void tick(); }, this.settings.intervalMs); timer.unref();
      }
    };
    void tick();
    return { stop: () => {
      controller.abort(); if (timer) clearTimeout(timer);
      for (let index = this.queue.length - 1; index >= 0; index--) if (this.queue[index]!.signal === controller.signal) this.queue.splice(index, 1);
      if (this.lost?.signal === controller.signal) this.lost = null;
    } };
  }
}
