import { randomUUID } from 'node:crypto';
import { DockerCommandFailure, dockerCommandEnvironment, type DockerCommandRunner } from '#adapters/core/docker-supervisor/index.js';
import { runNodeProcess } from './node.js';
import type { ProcessCommand } from './contract.js';
/** Explicit opt-in profile. Neither environment nor cwd is inherited from the host implicitly. */
export function createScopedNodeDockerRunner(profile: Pick<ProcessCommand, 'cwd' | 'env'>): DockerCommandRunner {
  const cwd = profile.cwd; const env = Object.freeze({ ...profile.env });
  return async (command, signal) => {
    const result = await runNodeProcess({ schemaVersion: 1, requestId: randomUUID(), ...command, cwd, env: dockerCommandEnvironment(command, env) }, signal);
    const stdout = Buffer.from(result.stdoutBase64, 'base64').toString('utf8');
    const stderr = Buffer.from(result.stderrBase64, 'base64').toString('utf8');
    if (result.reason !== 'exit' || result.exitCode !== 0) {
      throw new DockerCommandFailure(stdout, stderr, result.reason === 'exit' ? result.exitCode : null, result.reason !== 'exit');
    }
    return { stdout, stderr };
  };
}
