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
const exec = promisify(execFile);
export const runNodeDockerCommand: DockerCommandRunner = async (command, signal) => {
  const deadline = AbortSignal.timeout(command.timeoutMs);
  try {
    return await exec(command.executable, [...command.args], { maxBuffer: command.outputBytes, encoding: 'utf8',
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
  } catch (error) {
    const failure = error as { stdout?: unknown; stderr?: unknown; code?: unknown; killed?: unknown };
    throw new DockerCommandFailure(typeof failure.stdout === 'string' ? failure.stdout : '',
      typeof failure.stderr === 'string' ? failure.stderr : '', typeof failure.code === 'number' ? failure.code : null,
      !!failure.killed || typeof failure.code !== 'number');
  }
};
