import type { ResourceObservationSettings } from '#platform/index.js';
import type { SandboxRequest, ExecutionSupervisor } from '#engine/core/supervisor/index.js';
import { resourceGap, validateResourceSample, type ResourceReader, type ResourceSample, type ResourceTraceStore, type ResourceExecutionObserver } from './contract.js';
const MILLISECONDS_PER_SECOND = 1000;

/** One bounded collector owner per service. No launch, settlement or caller awaits trace I/O. */
export class ResourceCollector implements ResourceExecutionObserver {
  private active = 0;
  private writing = false;
  private readonly queue: ResourceSample[] = [];
  private lost: ResourceSample | null = null;
  constructor(private readonly store: ResourceTraceStore, private readonly settings: ResourceObservationSettings,
    private readonly now: () => number = Date.now) {}
  private enqueue(sample: ResourceSample) {
    if (this.queue.length >= this.settings.maxQueueEntries) { this.lost = resourceGap(sample.identity, this.now(), 'queue-full', sample.worker); return; }
    this.queue.push(sample); void this.drain();
  }
  private async drain() {
    if (this.writing) return; this.writing = true;
    try {
      while (this.queue.length) {
        const sample = this.queue.shift()!;
        try {
          if (this.lost) { await this.store.append(this.lost); this.lost = null; }
          await this.store.append(sample);
        } catch { this.lost = resourceGap(sample.identity, this.now(), 'store-unavailable', sample.worker); }
      }
    } finally { this.writing = false; }
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
        this.active++;
        try {
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.settings.timeoutMs)]);
          sample = validateResourceSample(await reader.readResources(request, worker, this.settings, signal), request.identity, worker);
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
        finally { this.active--; }
      }
      if (!controller.signal.aborted) this.enqueue(sample);
      if (!controller.signal.aborted && this.settings.enabled && reader.readResources && sample.gap !== 'unsupported') timer = setTimeout(() => { void tick(); }, this.settings.intervalMs);
    };
    void tick();
    return { stop() { controller.abort(); if (timer) clearTimeout(timer); } };
  }
}
