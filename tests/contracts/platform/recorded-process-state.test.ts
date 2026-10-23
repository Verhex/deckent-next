import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { HOST_LIMITS_REGISTRY, recordedProcessState } from '#platform/index.js';

// S6R-3 N7 (lead on s6 Q: pid liveness hardened against PID reuse): a launcher recorded (pid, startedAt) is gone on ESRCH, and also when the
// process now holding that pid started clearly after the recorded start (Linux /proc start time). Every doubt reads `alive`: fencing a
// healthy worker is the failure this must never introduce.
const btime = 1_700_000_000, hz = HOST_LIMITS_REGISTRY.procClockTicksPerSecond, tolerance = HOST_LIMITS_REGISTRY.processStartToleranceMs;
const proc = (startTicks: number, state = 'S') => (path: string) => {
  if (path === '/proc/stat') return `cpu  1 2 3\nbtime ${btime}\nprocesses 9\n`;
  return `${process.pid} (node (x) y) ${state} 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 ${startTicks} 99 100`;
};
const startedAtFor = (ticks: number) => btime * 1000 + (ticks * 1000) / hz;

it('an ended process is gone', () => {
  expect(recordedProcessState(spawnSync(process.execPath, ['-e', '']).pid!, Date.now())).toBe('gone');
});

it.skipIf(process.platform !== 'linux')('this process, recorded with its own start, is alive (real /proc)', () => {
  expect(recordedProcessState(process.pid, Date.now())).toBe('alive');
});

it.skipIf(process.platform !== 'linux')('a pid now held by a process that started after the recorded start (reuse) is gone; within the tolerance it stays alive', () => {
  const ticks = 500_000, started = startedAtFor(ticks);
  expect(recordedProcessState(process.pid, started - tolerance - 1_000, proc(ticks))).toBe('gone');
  expect(recordedProcessState(process.pid, started - tolerance + 1, proc(ticks))).toBe('alive');
  expect(recordedProcessState(process.pid, started + 5_000, proc(ticks))).toBe('alive');
});

it.skipIf(process.platform !== 'linux')('a zombie is gone; unreadable or malformed /proc reads alive', () => {
  expect(recordedProcessState(process.pid, Date.now(), proc(1, 'Z'))).toBe('gone');
  expect(recordedProcessState(process.pid, 0, () => { throw new Error('EACCES'); })).toBe('alive');
  expect(recordedProcessState(process.pid, 0, path => path === '/proc/stat' ? 'no boot time' : proc(1)(path))).toBe('alive');
  expect(recordedProcessState(process.pid, 0, path => path === '/proc/stat' ? proc(1)(path) : 'garbage')).toBe('alive');
});
