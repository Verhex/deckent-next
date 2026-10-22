import { existsSync } from 'node:fs';
import { expect, it } from 'vitest';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { DockerCommandFailure, DockerImageProbeError, probeDockerImageAvailability, probeDockerImageSetAvailability, runNodeDockerCommand, type DockerCommand } from '#adapters/core/docker-supervisor/index.js';

const imageId = `sha256:${'a'.repeat(64)}`;
const control = { executable: '/usr/bin/docker', timeoutMs: 1_000, outputBytes: 8_192, imageId };
const endpoint = 'unix:///run/user/1000/docker.sock';

it('pins a context endpoint, proves the exact local image ID, and detects daemon rebinding', async () => {
  const calls: DockerCommand[] = [];
  const runner = async (command: DockerCommand) => {
    calls.push(command);
    if (command.args[0] === 'context') return { stdout: JSON.stringify({ Host: endpoint }), stderr: '' };
    if (command.args[2] === 'image') return { stdout: `${imageId}\n`, stderr: '' };
    return { stdout: 'daemon-a\n', stderr: '' };
  };
  await expect(probeDockerImageAvailability(control, runner)).resolves.toEqual({ endpoint, daemonId: 'daemon-a', imageId, status: 'locally-available' });
  expect(calls.map(command => command.args)).toEqual([
    ['context', 'inspect', '--format', '{{json .Endpoints.docker}}'],
    ['--host', endpoint, 'info', '--format', '{{.ID}}'],
    ['--host', endpoint, 'image', 'inspect', imageId, '--format', '{{.Id}}'],
    ['--host', endpoint, 'info', '--format', '{{.ID}}'],
  ]);

  let infos = 0;
  await expect(probeDockerImageAvailability(control, async command => {
    if (command.args[0] === 'context') return { stdout: JSON.stringify({ Host: endpoint }), stderr: '' };
    if (command.args[2] === 'image') return { stdout: imageId, stderr: '' };
    return { stdout: ++infos === 1 ? 'daemon-a' : 'daemon-b', stderr: '' };
  })).rejects.toMatchObject({ code: 'DOCKER_IMAGE_PROBE_CHANGED' });
});

it('returns typed errors for invalid controls and unavailable or nonexact image observations', async () => {
  let calls = 0;
  const neverRun = async () => { calls++; return { stdout: '', stderr: '' }; };
  for (const invalid of [null, undefined, [], { ...control, executable: 'docker' }, { ...control, timeoutMs: undefined }]) {
    await expect(probeDockerImageAvailability(invalid, neverRun)).rejects.toMatchObject({ code: 'DOCKER_IMAGE_PROBE_INVALID' });
  }
  expect(calls).toBe(0);
  await expect(probeDockerImageAvailability(control, async () => { throw new Error('credential=not-exposed'); }))
    .rejects.toEqual(new DockerImageProbeError('DOCKER_IMAGE_PROBE_UNAVAILABLE'));
  await expect(probeDockerImageAvailability(control, async command => {
    if (command.args[0] === 'context') return { stdout: JSON.stringify({ Host: endpoint }), stderr: '' };
    if (command.args[2] === 'image') return { stdout: `sha256:${'b'.repeat(64)}`, stderr: '' };
    return { stdout: 'daemon-a', stderr: '' };
  })).rejects.toMatchObject({ code: 'DOCKER_IMAGE_PROBE_UNAVAILABLE' });
});

it('E1: an UNAVAILABLE image probe keeps a bounded cause of its failed Docker step (deadline|exit|signal|parse), never Docker text', async () => {
  const ok = (stdout: string) => ({ stdout, stderr: '' });
  const failing = (step: 'context' | 'info' | 'image', failure: () => never | { stdout: string; stderr: string }) => async (command: DockerCommand) => {
    const name = command.args[0] === 'context' ? 'context' : command.args[2] === 'image' ? 'image' : 'info';
    if (name === step) return failure();
    return name === 'context' ? ok(JSON.stringify({ Host: endpoint })) : name === 'image' ? ok(imageId) : ok('daemon-a');
  };
  const cases = [
    ['deadline', failing('info', () => { throw new DockerCommandFailure('', 'secret stderr', null, true, 'deadline'); })],
    ['exit', failing('image', () => { throw new DockerCommandFailure('', 'Error: No such image', 1, false); })],
    ['signal', failing('context', () => { throw new DockerCommandFailure('', '', null, true, 'signal', 'aborted'); })],
    ['parse', failing('context', () => ok('not json'))],
    ['parse', failing('context', () => ok(JSON.stringify({ Host: 'tcp://remote:2375' })))],
    ['parse', failing('info', () => ok('  \n'))],
    ['parse', failing('image', () => ok(`sha256:${'b'.repeat(64)}`))],
  ] as const;
  for (const [cause, runner] of cases) {
    const failure = await probeDockerImageAvailability(control, runner).catch((error: unknown) => error) as DockerImageProbeError;
    expect(failure).toBeInstanceOf(DockerImageProbeError); expect(failure).toMatchObject({ code: 'DOCKER_IMAGE_PROBE_UNAVAILABLE', probeCause: cause });
    expect(JSON.stringify(failure)).not.toContain('secret stderr'); expect(failure.message).toBe('DOCKER_IMAGE_PROBE_UNAVAILABLE');
  }
  // An unclassified runner failure keeps no cause (never a guess); the cause reaches the typed query error and its words (EN/TR).
  expect(await probeDockerImageAvailability(control, async () => { throw new Error('credential=not-exposed'); }).catch((error: unknown) => error)).not.toHaveProperty('probeCause', expect.anything());
  const mapped = queryFailure(new DockerImageProbeError('DOCKER_IMAGE_PROBE_UNAVAILABLE', 'deadline'));
  expect(mapped).toMatchObject({ code: 'DOCKER_IMAGE_PROBE_UNAVAILABLE', params: { cause: 'deadline' } });
  expect(mapped.localize('en').message).toContain('the Docker command reached its time limit'); expect(mapped.localize('tr').message).toContain('Docker komutu süre sınırına ulaştı');
  expect(queryFailure(new DockerImageProbeError('DOCKER_IMAGE_PROBE_UNAVAILABLE')).localize('en').message).toBe('The exact image could not be verified on the selected local Docker daemon.');
});

it('J3-IMAGES: proves a list with one endpoint pin, one daemon id read before and after and chunked exact-id inspects; typed refusals', async () => {
  const other = `sha256:${'b'.repeat(64)}`, missing = `sha256:${'c'.repeat(64)}`, list = { ...control, imageIds: [imageId, missing, other], chunkSize: 2, processes: 1 };
  const calls: DockerCommand[] = [];
  let infos = 0;
  const runner = (daemons: readonly string[]) => async (command: DockerCommand) => {
    calls.push(command);
    if (command.args[0] === 'context') return { stdout: JSON.stringify({ Host: endpoint }), stderr: '' };
    if (command.args[2] === 'info') return { stdout: daemons[Math.min(infos++, daemons.length - 1)]!, stderr: '' };
    const found = command.args.slice(4, -2).filter(id => id !== missing).map(id => `${id}\n`).join('');
    if (command.args.includes(missing)) throw new DockerCommandFailure(`${found}sha256:${'d'.repeat(64)}\n`, 'No such image', 1, false);
    return { stdout: found, stderr: '' };
  };
  await expect(probeDockerImageSetAvailability(list, runner(['daemon-a']))).resolves.toEqual({ imageIds: [imageId, other], partial: false });
  expect(calls.map(command => command.args)).toEqual([
    ['context', 'inspect', '--format', '{{json .Endpoints.docker}}'],
    ['--host', endpoint, 'info', '--format', '{{.ID}}'],
    ['--host', endpoint, 'image', 'inspect', imageId, missing, '--format', '{{.Id}}'],
    ['--host', endpoint, 'image', 'inspect', other, '--format', '{{.Id}}'],
    ['--host', endpoint, 'info', '--format', '{{.ID}}'],
  ]);
  infos = 0;
  await expect(probeDockerImageSetAvailability(list, runner(['daemon-a', 'daemon-b']))).rejects.toMatchObject({ code: 'DOCKER_IMAGE_PROBE_CHANGED' });
  for (const invalid of [{ ...list, imageIds: ['latest'] }, { ...list, chunkSize: 0 }, { ...list, processes: undefined }, { ...list, executable: 'docker' }, [list]]) {
    await expect(probeDockerImageSetAvailability(invalid, runner(['daemon-a']))).rejects.toMatchObject({ code: 'DOCKER_IMAGE_PROBE_INVALID' });
  }
  await expect(probeDockerImageSetAvailability(list, async () => { throw new Error('credential=not-exposed'); })).rejects.toEqual(new DockerImageProbeError('DOCKER_IMAGE_PROBE_UNAVAILABLE'));
});

const configuredImage = process.env.DECKENT_TEST_DOCKER_IMAGE;
it.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/docker') || !configuredImage)('proves the explicitly configured local image is available read-only', async () => {
  const result = await probeDockerImageAvailability({ ...control, imageId: configuredImage! }, runNodeDockerCommand);
  expect(result).toMatchObject({ status: 'locally-available', imageId: configuredImage });
  // The real CLI prints the found id and exits 1 for the absent one; the list probe keeps only the proven id.
  const absent = `sha256:${'f'.repeat(64)}`;
  await expect(probeDockerImageSetAvailability({ ...control, timeoutMs: 5_000, imageIds: [absent, configuredImage!], chunkSize: 16, processes: 4 }, runNodeDockerCommand)).resolves.toEqual({ imageIds: [configuredImage], partial: false });
});
