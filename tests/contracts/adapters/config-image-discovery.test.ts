import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CONFIG_DISCOVERY_BOUNDS, discoverConfigImages } from '#adapters/core/config-file/index.js';
import { DockerCommandFailure, type DockerCommand } from '#adapters/core/docker-supervisor/index.js';

// J3-IMAGES: `deckent config` waited ~5.8 s on the `images` choice source (43 local images × 4 docker calls each under one 5 s deadline).
// Every test runs on a controlled clock: the fake docker answers through the faked `setTimeout`, every deadline (`AbortSignal.timeout`) is a
// faked timer and `performance.now()` is the fake clock, so the order of answers, deadline and after-check is fixed by the test, not the host.
// The fake behaves like the CLI: `image inspect a b` prints the ids it found and exits 1 when one is missing; an aborted call rejects.
const id = (n: number) => `sha256:${n.toString(16).padStart(64, '0')}`;
const endpoint = 'unix:///var/run/docker.sock', stepMs = 10;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), ms);
    return controller.signal;
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
function fakeDocker(ids: readonly string[], options: { missing?: readonly string[]; hang?: string; daemons?: readonly string[] } = {}) {
  const calls: { args: string[]; at: number }[] = [];
  let infos = 0;
  const runner = (command: DockerCommand, signal?: AbortSignal) => new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const args = [...command.args]; calls.push({ args, at: performance.now() });
    const inspected = args[2] === 'image' && args[3] === 'inspect' ? args.slice(4, -2) : [];
    const answer = () => {
      if (args[0] === 'image' && args[1] === 'ls') return resolve({ stdout: ids.join('\n') + '\n', stderr: '' });
      if (args[0] === 'context') return resolve({ stdout: JSON.stringify({ Host: endpoint }), stderr: '' });
      if (args[2] === 'info') { const daemons = options.daemons ?? ['daemon-a']; return resolve({ stdout: `${daemons[Math.min(infos++, daemons.length - 1)]}\n`, stderr: '' }); }
      const found = inspected.filter(value => !options.missing?.includes(value));
      if (found.length === inspected.length) return resolve({ stdout: found.map(value => `${value}\n`).join(''), stderr: '' });
      reject(new DockerCommandFailure(found.map(value => `${value}\n`).join(''), 'Error response from daemon: No such image', 1, false));
    };
    const timer = options.hang && inspected.includes(options.hang) ? undefined : setTimeout(answer, stepMs);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DockerCommandFailure('', '', null, true, 'signal', signal.reason)); }, { once: true });
  });
  return { runner, calls, infos: () => calls.filter(call => call.args[2] === 'info') };
}
/** Runs discovery to the end of its deadline on the fake clock; the outcome is captured before the clock moves (no unhandled rejection). */
async function discover(docker: ReturnType<typeof fakeDocker>, limits: Parameters<typeof discoverConfigImages>[1]) {
  const outcome = discoverConfigImages('/usr/bin/docker', limits, docker.runner).then(value => ({ value }), (error: unknown) => ({ error: String(error) }));
  await vi.advanceTimersByTimeAsync(limits.timeoutMs);
  return outcome;
}
const limits = { timeoutMs: 400, outputBytes: 65_536, maxEntries: 64 };
const twelve = Array.from({ length: 12 }, (_, n) => id(n + 1));

it('verifies a slow daemon\'s whole image list within the deadline with one endpoint pin and one daemon id check before and after', async () => {
  const docker = fakeDocker(twelve);
  // Before J3-IMAGES: 1 + 12 × 4 sequential calls × 10 ms > 400 ms → the deadline fired and every verified image was thrown away.
  expect(await discover(docker, limits)).toEqual({ value: twelve });
  expect(docker.calls.filter(call => call.args[0] === 'context')).toHaveLength(1);
  expect(docker.infos()).toHaveLength(2);
  const inspects = docker.calls.filter(call => call.args[3] === 'inspect').map(call => call.args);
  expect(inspects.every(args => args[0] === '--host' && args[1] === endpoint)).toBe(true);
  expect(inspects.flatMap(args => args.slice(4, -2)).sort()).toEqual([...twelve].sort());
  expect(inspects.length).toBeLessThan(twelve.length);
});

it('excludes an id the inspect does not return, refuses the list when the daemon changes between the checks, and proposes nothing else', async () => {
  const ids = [id(1), id(2), id(3)];
  expect(await discover(fakeDocker(ids, { missing: [id(2)] }), limits)).toEqual({ value: [id(1), id(3)] });
  expect(await discover(fakeDocker(ids, { daemons: ['daemon-a', 'daemon-b'] }), limits)).toEqual({ value: [] });
  expect(await discover(fakeDocker([...ids, 'sha256:short', 'not-an-id']), limits)).toEqual({ value: ids });
});

it('keeps the images proven before the deadline and still runs the daemon id check after them', async () => {
  // Fixed order: ls (t=0..10), context (10..20), info (20..30); every inspect chunk answers at t=40 except the one holding id 12, which never
  // answers. Inspects are cut at the deadline (t=400) minus twice the measured info read (20 ms) = t=380; the after-check runs 380..390.
  const docker = fakeDocker(twelve, { hang: id(12) });
  const size = Math.min(CONFIG_DISCOVERY_BOUNDS.imageChunk, Math.ceil(twelve.length / CONFIG_DISCOVERY_BOUNDS.imageProcesses));
  const hung = twelve.slice(Math.floor(11 / size) * size, Math.floor(11 / size) * size + size), proven = twelve.filter(value => !hung.includes(value));
  expect(await discover(docker, limits)).toEqual({ value: proven });
  expect(proven.length).toBeGreaterThan(0);
  expect(proven).not.toContain(id(12));
  expect(docker.infos().map(call => call.at)).toEqual([20, 380]);
  // A daemon swap is still refused when the list is partial.
  expect(await discover(fakeDocker(twelve, { hang: id(12), daemons: ['daemon-a', 'daemon-b'] }), limits)).toEqual({ value: [] });
});
