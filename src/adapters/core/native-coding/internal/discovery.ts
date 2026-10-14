import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { ErrorRegistry, DOCKER_EXECUTION_SETTINGS } from '#platform/index.js';
import { nativeCliCommand } from '#adapters/core/native-cli-registry/index.js';
import { probeDockerImageAvailability, runNodeDockerCommand, type DockerCommandRunner } from '#adapters/core/docker-supervisor/index.js';

/** The pin is measured in the selected immutable worker image, with no workspace, credentials or network. */
export async function detectNativeCliVersion(provider: string, input: unknown, runner: DockerCommandRunner = runNodeDockerCommand,
  identity: { readonly uid: number; readonly gid: number } = userInfo()): Promise<string> {
  const settings = DOCKER_EXECUTION_SETTINGS.parse(input), executable = nativeCliCommand(provider).executable;
  if (identity.uid <= 0 || identity.gid < 0) throw ErrorRegistry.createError('INITIAL_REGISTRY_CLI_UNAVAILABLE');
  const name = `deckent-registry-${randomUUID()}`;
  const run = (args: readonly string[]) => runner({ executable: settings.executable, args, timeoutMs: settings.controlTimeoutMs, outputBytes: settings.outputBytes });
  let endpoint: string, daemonId: string;
  try { ({ endpoint, daemonId } = await probeDockerImageAvailability({ executable: settings.executable, imageId: settings.imageId,
    timeoutMs: settings.controlTimeoutMs, outputBytes: settings.outputBytes }, runner)); }
  catch { throw ErrorRegistry.createError('INITIAL_REGISTRY_CLI_UNAVAILABLE'); }
  const command = (args: readonly string[]) => run(['--host', endpoint, ...args]);
  let version: string | null = null;
  try {
    await command(['create', '--name', name, '--pull=never', '--network=none', '--read-only', '--cap-drop=ALL',
      '--security-opt=no-new-privileges', '--no-healthcheck', '--log-driver', 'none', '--user', `${identity.uid}:${identity.gid}`, '--pids-limit', String(settings.pids),
      '--memory', String(settings.memoryBytes), '--memory-swap', String(settings.memoryBytes), '--cpus', String(settings.cpus),
      '--tmpfs', `/tmp:rw,nosuid,nodev,size=${settings.tmpBytes},mode=1777`, '--workdir', '/tmp',
      '--env', 'HOME=/tmp', '--env', 'DISABLE_AUTOUPDATER=1', '--entrypoint', executable, settings.imageId, '--version']);
    const output = (await command(['start', '--attach', name])).stdout.trim();
    const code = (await command(['inspect', '--format', '{{.State.ExitCode}}', name])).stdout.trim();
    if (code !== '0' || !/^[\w .()+-]{1,128}$/.test(output) || !/\d+\.\d+\.\d+/.test(output)) throw new Error();
    if ((await command(['info', '--format', '{{.ID}}'])).stdout.trim() !== daemonId) throw new Error();
    version = output;
  } catch { /* The typed refusal follows cleanup; raw process output is never retained. */ }
  // An ambiguous create/start is never retried. Remove our unique probe name even on timeout; failed cleanup blocks publication.
  try { await command(['rm', '--force', name]); }
  catch { throw ErrorRegistry.createError('INITIAL_REGISTRY_PROBE_CLEANUP', { params: { container: name } }); }
  if (version === null) throw ErrorRegistry.createError('INITIAL_REGISTRY_CLI_UNAVAILABLE');
  return version;
}
