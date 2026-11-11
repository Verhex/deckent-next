import { readTimingFiles } from './timing-file.js';
import REGISTRY from './timing-registry.json' with { type: 'json' };
import COMMANDS from './timing-commands.json' with { type: 'json' };
import type { TimingPhase } from './timing-trace.js';
export interface TimingSummary { dropped: number; commands: { command: string; samples: number; median: number; p95: number; slowestPhase: TimingPhase }[] }
/** The read boundary projects only validated enum/numeric fields; hostile file contents never become terminal text. */
export async function readTimingSummary(env: NodeJS.ProcessEnv = process.env): Promise<TimingSummary> {
  const traces = new Map<string, { command: string; phases: Map<TimingPhase, number> }>(); let dropped = 0;
  for (const file of await readTimingFiles(env)) for (const line of file.split('\n')) {
    if (!line || Buffer.byteLength(line) > REGISTRY.maxRecordBytes) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (row['schemaVersion'] !== 1 || typeof row['traceId'] !== 'string' || !/^[0-9a-f-]{36}$/u.test(row['traceId'])
        || typeof row['command'] !== 'string' || !COMMANDS.includes(row['command']) || typeof row['phase'] !== 'string' || !REGISTRY.phases.includes(row['phase'])
        || typeof row['elapsedMs'] !== 'number' || !Number.isFinite(row['elapsedMs']) || row['elapsedMs'] < 0) continue;
      const trace = traces.get(row['traceId']) ?? { command: row['command'], phases: new Map<TimingPhase, number>() };
      if (trace.command !== row['command']) continue;
      trace.phases.set(row['phase'] as TimingPhase, row['elapsedMs']); traces.set(row['traceId'], trace);
      const count = (row['counts'] as { dropped?: { count?: unknown } } | undefined)?.dropped?.count;
      if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) dropped = Math.max(dropped, count);
    } catch { /* Malformed/partial lines are not evidence. */ }
  }
  const groups = new Map<string, { samples: number[]; phases: Map<TimingPhase, number[]> }>();
  for (const trace of traces.values()) {
    if (!trace.phases.has('finished')) continue;
    const slash = trace.phases.has('queued');
    if (!slash && !trace.phases.has('process-entry')) continue;
    if (slash && ['model', 'provider', 'status', 'doctor', 'chat-backend'].includes(trace.command) && !trace.phases.has('populated-flush')) continue;
    const command = slash ? `/${trace.command}` : `deckent ${trace.command}`;
    // A picker's later close is never time-to-screen. CLI samples end at first output, slash samples at the populated/first flush.
    const end = trace.phases.get('populated-flush') ?? trace.phases.get('first-flush') ?? trace.phases.get('first-output');
    if (end === undefined) continue;
    const group = groups.get(command) ?? { samples: [], phases: new Map<TimingPhase, number[]>() }; group.samples.push(end);
    let before = 0;
    for (const [phase, elapsed] of trace.phases) {
      if (elapsed > end || phase === 'finished' || phase === 'exit' || phase === 'cancelled') continue;
      const durations = group.phases.get(phase) ?? []; durations.push(Math.max(0, elapsed - before)); group.phases.set(phase, durations); before = elapsed;
    }
    groups.set(command, group);
  }
  const percentile = (values: number[], fraction: number) => values.slice().sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)]!;
  return { dropped, commands: [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([command, group]) => {
    const sorted = group.samples.slice().sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
    const slowestPhase = [...group.phases].sort((a, b) => percentile(b[1], .95) - percentile(a[1], .95))[0]![0];
    return { command, samples: sorted.length, median: sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2,
      p95: percentile(sorted, .95), slowestPhase };
  }) };
}
