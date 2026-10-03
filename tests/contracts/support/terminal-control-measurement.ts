import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { type WorklineStreamTurn } from '#surfaces/core/terminal/index.js';
import { mountWorkline, settle, WORKLINE_TEST_LABELS } from './workline-harness.js';
import { LATENCY_METRICS, latencySample, readLatencyClock, summarizeLatency, type LatencyMetric, type LatencySample, type Stamp } from './latency-metrics.js';

export const CONTROL_WORKLOAD = Object.freeze({ id: 'TC-M-fake-workline-v1', samples: 25, warmup: 5, columns: 200, rows: 60,
  history: 0, turnsPerMount: 1, textEvents: 1, approvals: 1, compactions: 1, modelDelayMs: 12, compactionDelayMs: 8,
  debug: false, interactive: true, palette: 'none', timeoutMs: 5_000 });
type Pending = { start: Stamp; match: (text: string) => boolean; finish: (end: Stamp) => void };

async function oneSample(index: number, now: () => number) {
  const samples: Partial<Record<LatencyMetric, LatencySample>> = {}, pending = new Map<LatencyMetric, Pending>();
  const stamp = () => readLatencyClock(now);
  const arm = (metric: LatencyMetric, match: (text: string) => boolean) => new Promise<void>(resolve => {
    const start = stamp();
    const timer = setTimeout(() => finish(null), CONTROL_WORKLOAD.timeoutMs);
    const finish = (end: Stamp) => { clearTimeout(timer); pending.delete(metric); samples[metric] = latencySample(start, end); resolve(); };
    pending.set(metric, { start, match, finish });
  });
  const observe = (text: string) => { for (const value of [...pending.values()]) if (value.match(text)) value.finish(stamp()); };
  const streamMarker = `TCM-STREAM-${index}`, approvalMarker = `TCM-APPROVAL-${index}`;
  let streamPaint!: Promise<void>, approvalPaint!: Promise<void>, producerEnd!: () => void;
  const ended = new Promise<void>(resolve => { producerEnd = resolve; });
  const streamTurn: WorklineStreamTurn = async function* (_messages, signal) {
    try {
      const compactionStart = stamp();
      yield { kind: 'context', promptTokens: 90_000, windowTokens: 100_000, quality: 'provider-count', compacting: true };
      await settle(CONTROL_WORKLOAD.compactionDelayMs);
      samples.compactionWall = latencySample(compactionStart, stamp());
      yield { kind: 'compacted', replacedMessages: 0, messages: [] };
      const modelStart = stamp(); await settle(CONTROL_WORKLOAD.modelDelayMs);
      samples.modelGenerationWall = latencySample(modelStart, stamp());
      streamPaint = arm('streamEventPaint', text => text.includes(streamMarker));
      yield { kind: 'text', text: streamMarker }; await streamPaint;
      approvalPaint = arm('approvalCard', text => text.includes(approvalMarker) && text.includes('A-TITLE'));
      yield { kind: 'approval', phase: 'requested', callId: 'c1', approvalId: 'fake-approval', revision: 0,
        summary: approvalMarker, preview: 'fake read_file (no effect)', expiresAt: Date.now() + 60_000 };
      await approvalPaint;
      yield { kind: 'approval', phase: 'settled', callId: 'c1', approvalId: 'fake-approval', outcome: 'cancelled' };
      // A separate event signals that the card has closed. This wait is outside the measured producer/control intervals.
      yield { kind: 'text', text: '\nTCM-CARD-CLOSED' };
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
      yield { kind: 'done', finish: 'cancelled' };
    } finally { producerEnd(); }
  };
  const startup = arm('startupFirstFrame', text => text.includes('READY'));
  const view = mountWorkline({ streamTurn, labels: { ...WORKLINE_TEST_LABELS, render: { ...WORKLINE_TEST_LABELS.render,
    cancelledDuring: { compaction: 'CANCEL-ACK', model: 'CANCEL-ACK', tool: 'CANCEL-ACK' } } } }, CONTROL_WORKLOAD.columns,
  { onFrame: observe, debug: CONTROL_WORKLOAD.debug });
  try {
    await startup; await view.instance.waitUntilRenderFlush(); await settle(20);
    const busy = arm('submitBusy', text => text.includes('BUSY'));
    view.stdin.write('measure\r'); await busy;
    // Wait for the generator to finish presenting the card, including the passive input subscription change.
    for (let tries = 0; !approvalPaint && tries < 500; tries++) await settle(10);
    if (approvalPaint) await approvalPaint;
    for (let tries = 0; !view.stdout.text.includes('TCM-CARD-CLOSED') && tries < 500; tries++) await settle(10);
    await view.instance.waitUntilRenderFlush(); await settle(20);
    let footer = false, ready = false;
    const cancel = arm('cancelAcknowledgement', text => { footer ||= text.includes('CANCEL-ACK'); ready ||= text.includes('READY'); return footer && ready; });
    view.stdin.write('\u001b'); await cancel;
  } finally {
    // The real surface unmount aborts an unfinished fake turn; no service, child process or model was admitted.
    view.instance.unmount();
    for (const value of [...pending.values()]) value.finish(null);
    await Promise.race([ended, settle(100)]);
  }
  return samples;
}

/** Uses one collector for all producer and control intervals. Invalid/missing evidence remains explicit. */
export async function measureTerminalControl(now: () => number = () => performance.now()) {
  const series = Object.fromEntries(LATENCY_METRICS.map(metric => [metric, [] as LatencySample[]])) as Record<LatencyMetric, LatencySample[]>;
  for (let index = 0; index < CONTROL_WORKLOAD.warmup + CONTROL_WORKLOAD.samples; index++) {
    const sample = await oneSample(index, now);
    if (index >= CONTROL_WORKLOAD.warmup) for (const metric of LATENCY_METRICS) if (sample[metric]) series[metric].push(sample[metric]);
  }
  return Object.fromEntries(LATENCY_METRICS.map(metric => [metric, summarizeLatency(series[metric], CONTROL_WORKLOAD.samples)]));
}

async function treeDigest(root: string) {
  const digest = createHash('sha256');
  async function visit(path: string) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) { const body = await readFile(child); digest.update(`${child}\0${body.length}\0`); digest.update(body); }
    }
  }
  await visit(root); return digest.digest('hex');
}
export async function terminalMeasurementIdentity(baseRevision: string) {
  if (!/^[0-9a-f]{40}$/.test(baseRevision)) throw new Error('TC_M_REVISION_REQUIRED');
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const lock = await readFile('package-lock.json');
  const installed = async (name: string) => JSON.parse(await readFile(`node_modules/${name}/package.json`, 'utf8')).version;
  return { schemaVersion: 1, measuredAt: new Date().toISOString(), version: { baseRevision, product: pkg.version,
    sourceSha256: await treeDigest('src'), harnessSha256: await treeDigest('tests/contracts/support'),
    lockSha256: createHash('sha256').update(lock).digest('hex'), ink: await installed('ink'), react: await installed('react'), vitest: await installed('vitest') },
  environment: { node: process.version, platform: platform(), arch: arch(), osRelease: release(), cpu: cpus()[0]?.model ?? 'unknown',
    logicalCpus: cpus().length, memoryBytes: totalmem(), tty: 'in-memory Writable (no physical screen)',
    maxWorkers: process.env['VITEST_MAX_FORKS'] ?? 'unknown', CI: process.env['CI'] ?? null, TERM: process.env['TERM'] ?? null,
    NO_COLOR: process.env['NO_COLOR'] ?? null, FORCE_COLOR: process.env['FORCE_COLOR'] ?? null },
  workload: CONTROL_WORKLOAD, clock: 'node:perf_hooks performance.now; same process monotonic milliseconds; stdout write observer',
  percentile: 'nearest rank ceil(n*p), warmup excluded, raw samples retained', target: { eventToHumanSurfaceP95Ms: 500, status: 'target; not acceptance' },
  limits: ['startup = warm Workline mount → READY frame write; process boot/import/service connect excluded',
    'paint = frame bytes received by in-memory stdout; physical terminal paint/flush not measured',
    'fake producer delays; no real model/GPU/network/runtime approval polling or effect execution',
    'modelGenerationWall = fake response stage to first text; compactionWall = fake compacting stage to compacted emission',
    'serial empty history workload; no long session, large history, cold startup or loaded-host performance acceptance'] };
}
