import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
export interface DockerCommand {
  readonly executable: string; readonly args: readonly string[]; readonly timeoutMs: number; readonly outputBytes: number;
}
export interface DockerCommandOutput { readonly stdout: string; readonly stderr: string }
/** Narrow process boundary; no Docker, task, policy or acceptance decisions belong in its implementation. */
export type DockerCommandRunner = (command: DockerCommand, signal?: AbortSignal) => Promise<DockerCommandOutput>;
export class DockerCommandFailure extends Error {
  constructor(readonly stdout: string, readonly stderr: string, readonly code: number | null, readonly killed: boolean) {
    super('SUPERVISOR_COMMAND_FAILED'); this.name = 'DockerCommandFailure';
  }
}
/** A pinned local endpoint must not inherit a conflicting context or TLS selector. */
export function dockerCommandEnvironment(command: DockerCommand, env: Readonly<Record<string, string | undefined>>) {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (command.args[0] === '--host' && ['DOCKER_CONTEXT', 'DOCKER_HOST', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'].includes(key)) continue;
    result[key] = value;
  }
  return result;
}
const exec = promisify(execFile);
export const runNodeDockerCommand: DockerCommandRunner = async (command, signal) => {
  const deadline = AbortSignal.timeout(command.timeoutMs);
  try {
    return await exec(command.executable, [...command.args], { maxBuffer: command.outputBytes, encoding: 'utf8',
      env: dockerCommandEnvironment(command, process.env),
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
  } catch (error) {
    const failure = error as { stdout?: unknown; stderr?: unknown; code?: unknown; killed?: unknown };
    throw new DockerCommandFailure(typeof failure.stdout === 'string' ? failure.stdout : '',
      typeof failure.stderr === 'string' ? failure.stderr : '', typeof failure.code === 'number' ? failure.code : null,
      !!failure.killed || typeof failure.code !== 'number');
  }
};
