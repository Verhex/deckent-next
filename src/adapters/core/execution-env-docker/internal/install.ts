import { spawn } from 'node:child_process';
import { access, constants, readFile } from 'node:fs/promises';
import { runDetectCommand, type DetectEnvironment } from '#adapters/core/setup-detect-execution/index.js';
import { DOCKER_APT, type DockerAptData } from './registry.js';
import { dockerSourcesFile, type DockerInstallPlan } from './plan.js';

export type DockerStepRun = Readonly<{ code: number | null; signal: string | null }>;
/** The host effect ports: `spawn` runs one foreground command on the person's terminal (stdio inherited, so sudo asks on it directly). */
export type DockerInstallPorts = Readonly<{ sudo: string; spawn: (file: string, args: readonly string[], options: Readonly<{ env: DetectEnvironment; timeoutMs: number }>) => Promise<DockerStepRun>;
  version: () => Promise<string | null>; verify?: () => Promise<boolean> }>;
/** `mismatch`: the installed key or source file was not the shipped one; the run stopped before `apt-get update` trusted it. */
export type DockerInstallResult = Readonly<{ status: 'succeeded' | 'failed' | 'uncertain'; step: number | null; exitCode: number | null; version: string | null; mismatch?: boolean }>;

/** sudo from the registry's absolute locations only (never a PATH lookup a project could shadow); null when none is executable. */
export async function resolveSudo(data: DockerAptData = DOCKER_APT): Promise<string | null> {
  for (const path of data.sudo) if (await access(path, constants.X_OK).then(() => true, () => false)) return path;
  return null;
}
/** The environment every sudo step gets: a fixed PATH and the terminal's type and language. No Deckent variable, token or secret. */
export const sudoEnvironment = (env: DetectEnvironment): DetectEnvironment =>
  Object.fromEntries(Object.entries({ PATH: '/usr/sbin:/usr/bin:/sbin:/bin', TERM: env['TERM'], LANG: env['LANG'], LC_ALL: env['LC_ALL'] }).filter(([, value]) => value));
export const spawnForeground: DockerInstallPorts['spawn'] = (file, args, options) => new Promise(done => {
  const child = spawn(file, [...args], { stdio: 'inherit', env: { ...options.env }, timeout: options.timeoutMs, killSignal: 'SIGTERM' });
  child.once('error', () => done({ code: null, signal: null }));
  child.once('close', (code, signal) => done({ code, signal }));
});
export const installedDockerVersion = (env: DetectEnvironment, data: DockerAptData = DOCKER_APT) => async () => {
  const listed = await runDetectCommand('dpkg-query', ['-W', '-f', '${Version}', data.packages[0]!], { env, timeoutMs: data.timeoutsMs.probe, outputBytes: data.outputBytes,
    signal: AbortSignal.timeout(data.timeoutsMs.probe) });
  return listed.code === 0 && /^[0-9A-Za-z.+:~_-]{1,64}$/.test(listed.stdout.trim()) ? listed.stdout.trim() : null;
};

/** Cond. 3 at install time: the key and source file root now holds must be byte-for-byte the shipped ones. The staging folder is this user's,
 * so another process of the same user could swap a file between the card and the copy; the installed copies are root-owned, so checking
 * them after the copy is sound, and a mismatch stops the run before `apt-get update` would trust that key. */
export const verifyInstalledSource = (plan: Extract<DockerInstallPlan, { kind: 'install' }>, data: DockerAptData = DOCKER_APT) => async () =>
  await readFile(data.keyring, 'utf8').catch(() => null) === `${data.key.armored.join('\n')}\n` && await readFile(data.sourcesFile, 'utf8').catch(() => null) === dockerSourcesFile(plan.source, data);

/**
 * The approved effect (INIT-D2 cond. 2/4): `sudo -k`, then each step in the foreground, in order, bounded by its registry timeout. sudo asks
 * for the password on the terminal itself; Deckent never reads, stores or passes it. A step that exits non-zero stops the run (`failed`, the
 * steps before it stay applied); a timeout, a signal or Ctrl+C makes the effect unknown (`uncertain`): the caller re-detects, never retries.
 */
export async function runDockerInstall(plan: Extract<DockerInstallPlan, { kind: 'install' }>, env: DetectEnvironment, ports: DockerInstallPorts): Promise<DockerInstallResult> {
  let interrupted = false;
  const onInterrupt = () => { interrupted = true; }, clean = sudoEnvironment(env);
  process.on('SIGINT', onInterrupt);
  try {
    const reset = await ports.spawn(ports.sudo, ['-k'], { env: clean, timeoutMs: DOCKER_APT.timeoutsMs.probe });
    if (reset.code !== 0) return { status: 'failed', step: 0, exitCode: reset.code, version: null };
    for (const [index, step] of plan.steps.entries()) {
      const run = await ports.spawn(ports.sudo, ['--', ...step.argv], { env: clean, timeoutMs: step.timeoutMs });
      if (interrupted || run.code === null) return { status: 'uncertain', step: index + 1, exitCode: run.code, version: null };
      if (run.code !== 0) return { status: 'failed', step: index + 1, exitCode: run.code, version: null };
      if (step.id === 'sources' && !await (ports.verify ?? verifyInstalledSource(plan))()) return { status: 'failed', step: index + 1, exitCode: null, version: null, mismatch: true };
    }
    return { status: 'succeeded', step: null, exitCode: 0, version: await ports.version() };
  } finally { process.off('SIGINT', onInterrupt); }
}
