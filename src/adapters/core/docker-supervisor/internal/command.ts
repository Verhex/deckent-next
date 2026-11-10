import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
export interface DockerCommand {
  readonly executable: string; readonly args: readonly string[]; readonly timeoutMs: number; readonly outputBytes: number;
}
export interface DockerCommandOutput { readonly stdout: string; readonly stderr: string }
/** Narrow process boundary; no Docker, task, policy or acceptance decisions belong in its implementation. */
export type DockerCommandRunner = (command: DockerCommand, signal?: AbortSignal) => Promise<DockerCommandOutput>;
export class DockerCommandFailure extends Error {
  /** `stop`: which bound stopped the process first (fixed by AbortSignal.any at that moment); `stopReason`: the signal's reason. */
  constructor(readonly stdout: string, readonly stderr: string, readonly code: number | null, readonly killed: boolean,
    readonly stop: 'deadline' | 'signal' | null = null, readonly stopReason?: unknown) {
    super('SUPERVISOR_COMMAND_FAILED'); this.name = 'DockerCommandFailure';
  }
}
/** A6-3 (owner 2026-11-08, alpha.63.2): `forward` names the only inherited service variables a Docker client process receives, one table for every
 * caller (both worker-image assets keep a copy pinned equal to it); a provider key or token never reaches the docker CLI, its plugins or credential
 * helpers. `stripOnHost`: a pinned local endpoint (`--host`) inherits no conflicting context or TLS selector (KG2 Q1.5: docker 29.1.3 given
 * `--host unix://…` fails to start on an inherited DOCKER_TLS_VERIFY/DOCKER_CERT_PATH). */
const DOCKER_CLIENT_ENV = Object.freeze([{ name: 'PATH', forward: true, stripOnHost: false }, { name: 'HOME', forward: true, stripOnHost: false },
  { name: 'DOCKER_HOST', forward: true, stripOnHost: true }, { name: 'DOCKER_CONTEXT', forward: true, stripOnHost: true }, { name: 'DOCKER_CONFIG', forward: true, stripOnHost: false },
  { name: 'DOCKER_TLS_VERIFY', forward: true, stripOnHost: true }, { name: 'DOCKER_CERT_PATH', forward: true, stripOnHost: true }, { name: 'DOCKER_TLS', forward: false, stripOnHost: true }]);
export const DOCKER_CLIENT_ENV_NAMES: readonly string[] = Object.freeze(DOCKER_CLIENT_ENV.filter(row => row.forward).map(row => row.name));
export const DOCKER_HOST_STRIP_NAMES: readonly string[] = Object.freeze(DOCKER_CLIENT_ENV.filter(row => row.stripOnHost).map(row => row.name));
/** The forwarded names of `env`; `pinnedHost` (the command starts with `--host`) also drops the selectors that would conflict with it. */
export function dockerClientEnvironment(env: Readonly<Record<string, string | undefined>>, pinnedHost = false): Record<string, string> {
  return Object.fromEntries(DOCKER_CLIENT_ENV_NAMES.flatMap(name => typeof env[name] === 'string' && !(pinnedHost && DOCKER_HOST_STRIP_NAMES.includes(name)) ? [[name, env[name]]] : []));
}
/** An explicit profile environment as given, less the selectors a pinned `--host` must not inherit. */
export function dockerCommandEnvironment(command: DockerCommand, env: Readonly<Record<string, string | undefined>>) {
  return Object.fromEntries(Object.entries(env).flatMap(([key, value]) =>
    value === undefined || command.args[0] === '--host' && DOCKER_HOST_STRIP_NAMES.includes(key) ? [] : [[key, value]])) as Record<string, string>;
}
const exec = promisify(execFile);
export const runNodeDockerCommand: DockerCommandRunner = async (command, signal) => {
  const deadline = AbortSignal.timeout(command.timeoutMs), bound = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    return await exec(command.executable, [...command.args], { maxBuffer: command.outputBytes, encoding: 'utf8',
      env: dockerClientEnvironment(process.env, command.args[0] === '--host'), signal: bound });
  } catch (error) {
    const failure = error as { stdout?: unknown; stderr?: unknown; code?: unknown; killed?: unknown };
    const killed = !!failure.killed || typeof failure.code !== 'number', stop = killed && bound.aborted ? bound.reason === deadline.reason ? 'deadline' : 'signal' : null;
    throw new DockerCommandFailure(typeof failure.stdout === 'string' ? failure.stdout : '',
      typeof failure.stderr === 'string' ? failure.stderr : '', typeof failure.code === 'number' ? failure.code : null, killed, stop, stop === 'signal' ? bound.reason : undefined);
  }
};
