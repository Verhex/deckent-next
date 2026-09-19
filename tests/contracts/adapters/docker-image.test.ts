import { existsSync } from 'node:fs';
import { expect, it } from 'vitest';
import { DockerImageProbeError, probeDockerImageAvailability, runNodeDockerCommand, type DockerCommand } from '#adapters/core/docker-supervisor/index.js';

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

const configuredImage = process.env.DECKENT_TEST_DOCKER_IMAGE;
it.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/docker') || !configuredImage)('proves the explicitly configured local image is available read-only', async () => {
  const result = await probeDockerImageAvailability({ ...control, imageId: configuredImage! }, runNodeDockerCommand);
  expect(result).toMatchObject({ status: 'locally-available', imageId: configuredImage });
});
