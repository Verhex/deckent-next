import { expect, it } from 'vitest';
import { detectNativeCliVersion } from '#adapters/core/native-coding/index.js';
import { nativeCliCommand } from '#adapters/core/native-cli-registry/index.js';
import type { DockerCommand, DockerCommandRunner } from '#adapters/core/docker-supervisor/index.js';

const settings = { executable: '/fixture/docker', imageId: `sha256:${'b'.repeat(64)}`, memoryBytes: 268435456, cpus: 1,
  pids: 64, logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 };
const detect = (provider: string, input: unknown, runner: DockerCommandRunner) => detectNativeCliVersion(provider, input, runner, { uid: 1000, gid: 1000 });
function fixture(failure?: string) {
  const calls: DockerCommand[] = [];
  const runner: DockerCommandRunner = async command => {
    calls.push(command); const args = command.args[0] === '--host' ? command.args.slice(2) : command.args;
    const action = args[0];
    if (action === failure) throw new Error('raw output must not escape');
    const stdout = action === 'context' ? JSON.stringify({ Host: 'unix:///fixture/docker.sock' }) : action === 'info' ? 'daemon'
      : action === 'image' ? settings.imageId : action === 'create' ? 'container' : action === 'start' ? '2.1.285 (Claude Code)'
      : action === 'inspect' ? '0' : 'removed';
    return { stdout, stderr: '' };
  };
  return { calls, runner };
}
it('measures inside the exact local image with isolation and configured bounds, and removes only its unique probe', async () => {
  const f = fixture(); expect(await detect('claude', settings, f.runner)).toBe('2.1.285 (Claude Code)');
  const create = f.calls.find(command => command.args.includes('create'))!;
  expect(create.args).toEqual(expect.arrayContaining(['--pull=never', '--network=none', '--read-only', '--cap-drop=ALL',
    '--security-opt=no-new-privileges', '--memory', String(settings.memoryBytes), '--memory-swap', String(settings.memoryBytes),
    '--cpus', String(settings.cpus), '--pids-limit', String(settings.pids)]));
  expect(create.args).not.toContain('--mount'); expect(create.args).not.toContain('--volume');
  expect(create.args).toContain('--no-healthcheck'); expect(create.args).toContain('--log-driver');
  expect(create.args[create.args.indexOf('--log-driver') + 1]).toBe('none');
  expect(create.args.slice(-4)).toEqual(['--entrypoint', nativeCliCommand('claude').executable, settings.imageId, '--version']);
  const name = create.args[create.args.indexOf('--name') + 1]!;
  expect(name).toMatch(/^deckent-registry-[a-f0-9-]{36}$/);
  expect(f.calls.at(-1)!.args).toEqual(['--host', 'unix:///fixture/docker.sock', 'rm', '--force', name]);
  for (const command of f.calls) expect(command).toMatchObject({ executable: settings.executable, timeoutMs: settings.controlTimeoutMs, outputBytes: settings.outputBytes });
});
it.each(['context', 'image', 'create', 'start', 'inspect', 'rm'])('refuses %s failure without inventing a version or exposing subprocess output', async action => {
  const f = fixture(action);
  await expect(detect('claude', settings, f.runner)).rejects.toMatchObject({ code: action === 'rm' ? 'INITIAL_REGISTRY_PROBE_CLEANUP' : 'INITIAL_REGISTRY_CLI_UNAVAILABLE' });
  if (['create', 'start', 'inspect'].includes(action)) expect(f.calls.at(-1)!.args).toContain('rm');
  if (['context', 'image'].includes(action)) expect(f.calls.some(call => call.args.includes('create'))).toBe(false);
});
it.each(['', 'unverified', '2.1.285\nsecret', '\u001b[31m2.1.285', 'v'.repeat(129)])('refuses malformed CLI output %j and still cleans up', async output => {
  const f = fixture();
  await expect(detect('claude', settings, command => command.args.includes('start')
    ? Promise.resolve({ stdout: output, stderr: '' }) : f.runner(command))).rejects.toMatchObject({ code: 'INITIAL_REGISTRY_CLI_UNAVAILABLE' });
  expect(f.calls.at(-1)!.args).toContain('rm');
});
it('requires zero container exit status even with a plausible version', async () => {
  const f = fixture();
  await expect(detect('claude', settings, command => command.args.includes('inspect') && command.args.includes('{{.State.ExitCode}}')
    ? Promise.resolve({ stdout: '17', stderr: '' }) : f.runner(command))).rejects.toMatchObject({ code: 'INITIAL_REGISTRY_CLI_UNAVAILABLE' });
  expect(f.calls.at(-1)!.args).toContain('rm');
});
it('refuses a changed Docker daemon between pin measurement and return', async () => {
  const f = fixture(); let observations = 0;
  await expect(detect('claude', settings, command => command.args.includes('info') && ++observations === 3
    ? Promise.resolve({ stdout: 'another-daemon', stderr: '' }) : f.runner(command))).rejects.toMatchObject({ code: 'INITIAL_REGISTRY_CLI_UNAVAILABLE' });
  expect(f.calls.at(-1)!.args).toContain('rm');
});

it.each([{ uid: 0, gid: 0 }, { uid: -1, gid: -1 }])('refuses unavailable non-root POSIX identity %j before Docker access', async identity => {
  const f = fixture();
  await expect(detectNativeCliVersion('claude', settings, f.runner, identity)).rejects.toMatchObject({ code: 'INITIAL_REGISTRY_CLI_UNAVAILABLE' });
  expect(f.calls).toEqual([]);
});
