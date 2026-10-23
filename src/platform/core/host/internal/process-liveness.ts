import { HOST_LIMITS_REGISTRY } from '#platform/core/common/index.js';
import { readProcessFile, type ProcessFileReader } from './service-manager.js';

/**
 * S6R-3 N7 (lead on s6 Q: PID reuse): whether the process that recorded `startedAtMs` as its start can still be the one holding `pid`.
 * `gone` on ESRCH, a zombie, or (Linux) a holder whose kernel start time (`/proc/<pid>/stat` starttime over `/proc/stat` btime, ticks from the
 * host-limits registry) lies clearly after the recorded start — a reused pid. Any other answer, read failure or OS reads `alive`: fencing a
 * healthy worker is the failure this must never cause. Evidence for detection only, never termination proof.
 */
export function recordedProcessState(pid: number, startedAtMs: number, read: ProcessFileReader = readProcessFile): 'alive' | 'gone' {
  try { process.kill(pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'alive'; }
  if (process.platform !== 'linux') return 'alive';
  try {
    const stat = read(`/proc/${pid}/stat`), boot = /^btime\s+(\d+)\s*$/mu.exec(read('/proc/stat') ?? '')?.[1];
    const fields = stat && stat.includes(')') ? stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u) : [];
    if (['Z', 'X', 'x'].includes(fields[0] ?? '')) return 'gone';
    const ticks = Number(fields[19]), btime = Number(boot);
    if (!fields[19] || !Number.isSafeInteger(ticks) || !boot || !Number.isSafeInteger(btime)) return 'alive';
    const { msPerSecond, procClockTicksPerSecond, processStartToleranceMs } = HOST_LIMITS_REGISTRY, holderStartedMs = (btime + ticks / procClockTicksPerSecond) * msPerSecond;
    return holderStartedMs > startedAtMs + processStartToleranceMs ? 'gone' : 'alive';
  } catch { return 'alive'; }
}
