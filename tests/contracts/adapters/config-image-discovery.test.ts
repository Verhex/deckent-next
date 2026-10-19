import { expect, it } from 'vitest';
import { discoverConfigImages } from '#adapters/core/config-file/index.js';
import { DockerCommandFailure, type DockerCommand } from '#adapters/core/docker-supervisor/index.js';

// J3-IMAGES: `deckent config` waited ~5.8 s on the `images` choice source (43 local images × 4 docker calls each under one 5 s deadline).
// The fake docker answers every call after `delayMs` (aborted with the caller's signal like the real runner) and behaves like the CLI:
// `image inspect a b` prints the ids it found and exits 1 when one is missing.
const id = (n: number) => `sha256:${n.toString(16).padStart(64, '0')}`;
const endpoint = 'unix:///var/run/docker.sock';
function fakeDocker(ids: readonly string[], options: { delayMs: number; infoDelayMs?: number; missing?: readonly string[]; hang?: string; daemons?: readonly string[] }) {
  const calls: string[][] = [];
  let infos = 0;
  const runner = (command: DockerCommand, signal?: AbortSignal) => new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const args = [...command.args]; calls.push(args);
    const inspected = args[2] === 'image' && args[3] === 'inspect' ? args.slice(4, -2) : [];
    const answer = () => {
      if (args[0] === 'image' && args[1] === 'ls') return resolve({ stdout: ids.join('\n') + '\n', stderr: '' });
      if (args[0] === 'context') return resolve({ stdout: JSON.stringify({ Host: endpoint }), stderr: '' });
      if (args[2] === 'info') { const daemons = options.daemons ?? ['daemon-a']; return resolve({ stdout: `${daemons[Math.min(infos++, daemons.length - 1)]}\n`, stderr: '' }); }
      const found = inspected.filter(value => !options.missing?.includes(value));
      if (found.length === inspected.length) return resolve({ stdout: found.map(value => `${value}\n`).join(''), stderr: '' });
      reject(new DockerCommandFailure(found.map(value => `${value}\n`).join(''), 'Error response from daemon: No such image', 1, false));
    };
    const timer = options.hang && inspected.includes(options.hang) ? undefined : setTimeout(answer, args[2] === 'info' ? options.infoDelayMs ?? options.delayMs : options.delayMs);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DockerCommandFailure('', '', null, true, 'signal', signal.reason)); }, { once: true });
  });
  return { runner, calls };
}
const limits = { timeoutMs: 600, outputBytes: 65_536, maxEntries: 64 };

it('verifies a slow daemon\'s whole image list within the deadline with one endpoint pin and one daemon id check before and after', async () => {
  const ids = Array.from({ length: 12 }, (_, n) => id(n + 1)), docker = fakeDocker(ids, { delayMs: 40 });
  // Before J3-IMAGES: 1 + 12 × 4 sequential calls × 40 ms > 600 ms → the deadline fired and every verified image was thrown away.
  await expect(discoverConfigImages('/usr/bin/docker', limits, docker.runner)).resolves.toEqual(ids);
  expect(docker.calls.filter(args => args[0] === 'context')).toHaveLength(1);
  expect(docker.calls.filter(args => args[2] === 'info')).toHaveLength(2);
  const inspects = docker.calls.filter(args => args[3] === 'inspect');
  expect(inspects.every(args => args[0] === '--host' && args[1] === endpoint)).toBe(true);
  expect(inspects.flatMap(args => args.slice(4, -2)).sort()).toEqual([...ids].sort());
  expect(inspects.length).toBeLessThan(ids.length);
});

it('excludes an id the inspect does not return, refuses the list when the daemon changes between the checks, and proposes nothing else', async () => {
  const ids = [id(1), id(2), id(3)];
  await expect(discoverConfigImages('/usr/bin/docker', limits, fakeDocker(ids, { delayMs: 1, missing: [id(2)] }).runner)).resolves.toEqual([id(1), id(3)]);
  await expect(discoverConfigImages('/usr/bin/docker', limits, fakeDocker(ids, { delayMs: 1, daemons: ['daemon-a', 'daemon-b'] }).runner)).resolves.toEqual([]);
  await expect(discoverConfigImages('/usr/bin/docker', limits, fakeDocker([...ids, 'sha256:short', 'not-an-id'], { delayMs: 1 }).runner)).resolves.toEqual(ids);
});

it('keeps the images proven before the deadline and still runs the daemon id check after them', async () => {
  // The daemon id read is the slowest call here: the after-check's reserve (2 × the measured before read) keeps ~60 ms of timer headroom.
  const slow = { delayMs: 15, infoDelayMs: 60, hang: id(12) }, ids = Array.from({ length: 12 }, (_, n) => id(n + 1)), docker = fakeDocker(ids, slow);
  const images = await discoverConfigImages('/usr/bin/docker', { ...limits, timeoutMs: 400 }, docker.runner);
  expect(images.length).toBeGreaterThan(0);
  expect(images).not.toContain(id(12));
  expect(images).toEqual(ids.filter(value => images.includes(value)));
  expect(docker.calls.filter(args => args[2] === 'info')).toHaveLength(2);
  // A daemon swap is still refused when the list is partial.
  await expect(discoverConfigImages('/usr/bin/docker', { ...limits, timeoutMs: 400 }, fakeDocker(ids, { ...slow, daemons: ['daemon-a', 'daemon-b'] }).runner)).resolves.toEqual([]);
});
