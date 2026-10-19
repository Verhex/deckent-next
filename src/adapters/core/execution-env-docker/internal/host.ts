import { chmod, lstat, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { isWslHost } from '#platform/index.js';
import { findExecutable, runDetectCommand, type DetectEnvironment, type DetectRunner } from '#adapters/core/setup-detect-execution/index.js';
import { DOCKER_APT, type DockerAptData } from './registry.js';
import { dockerSource, dockerSourcesFile, type DockerHostFacts, type DockerSource } from './plan.js';

/** Read-only host ports; tests replace them (no real dpkg, network or Windows drive needed). */
export type DockerHostPorts = Readonly<{ run: DetectRunner; find: typeof findExecutable; read: (path: string) => Promise<string | null>; exists: (path: string) => Promise<boolean>;
  reachable: (url: string, timeoutMs: number) => Promise<boolean>; platform: () => DockerHostFacts['platform']; user: () => string }>;
export const HOST_DOCKER_PORTS = (env: DetectEnvironment): DockerHostPorts => Object.freeze({ run: runDetectCommand, find: findExecutable, user: () => userInfo().username,
  read: (path: string) => readFile(path, 'utf8').catch(() => null), exists: (path: string) => lstat(path).then(() => true, () => false),
  platform: () => process.platform !== 'linux' ? 'other' : isWslHost('linux', env) ? 'wsl' : 'linux',
  // One bounded HEAD of the repository's signed release index: no body, no credentials; any failure reads as "no network".
  reachable: (url: string, timeoutMs: number) => fetch(url, { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(timeoutMs) }).then(response => response.ok, () => false) });

const parseOsRelease = (text: string | null) => text === null ? null
  : Object.fromEntries(text.split('\n').map(line => /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim())).filter(match => match !== null)
    .map(match => [match[1]!, match[2]!.replace(/^(["'])(.*)\1$/, '$2')]));
/** Everything the planner needs, read-only and bounded: release, architecture, installed conflicting packages, an older source file, Docker
 * Desktop on WSL, and whether the repository answers. Nothing is written and nothing runs with privileges. */
export async function observeDockerHost(env: DetectEnvironment, desktop: boolean, ports: DockerHostPorts = HOST_DOCKER_PORTS(env), data: DockerAptData = DOCKER_APT): Promise<DockerHostFacts> {
  const signal = AbortSignal.timeout(data.timeoutsMs.probe), platform = ports.platform(), user = ports.user();
  const run = async (name: string, args: readonly string[]) => {
    const file = await ports.find(name, env, 256, signal);
    return file ? ports.run(file, args, { env, timeoutMs: data.timeoutsMs.probe, outputBytes: data.outputBytes, signal }) : null;
  };
  let osRelease: Record<string, string> | null = null;
  for (const path of data.osRelease) if (!osRelease) osRelease = parseOsRelease(await ports.read(path));
  const architecture = (await run('dpkg', ['--print-architecture']))?.stdout.trim() || null;
  const listed = await run('dpkg-query', ['-W', '-f', '${Package} ${db:Status-Abbrev}\n', '--', ...data.conflicts]);
  const conflicts = (listed?.stdout ?? '').split('\n').map(line => line.trim().split(/\s+/)).filter(([name, status]) => data.conflicts.includes(name ?? '') && status?.startsWith('ii')).map(([name]) => name!);
  let existingSource: string | null = null;
  for (const path of data.existingSources) if (!existingSource && await ports.exists(path)) existingSource = path;
  const onDesktop = desktop || platform === 'wsl' && (await Promise.all(data.desktopMarkers.map(ports.exists))).some(Boolean);
  const source = dockerSource(osRelease, architecture, data);
  const network = source !== null && await ports.reachable(`${source.url}/dists/${source.codename}/InRelease`, data.timeoutsMs.network);
  return { platform, osRelease, architecture, desktop: onDesktop, conflicts, existingSource, network, user };
}

/** The shipped key and the source file in a new private directory (0700; files 0644, root reads them through sudo). Returns its path. */
export async function stageDockerFiles(source: DockerSource | null, data: DockerAptData = DOCKER_APT): Promise<string> {
  const staging = await mkdtemp(join(tmpdir(), 'deckent-docker-'));
  await chmod(staging, 0o700);
  await writeFile(join(staging, 'docker.asc'), `${data.key.armored.join('\n')}\n`, { mode: 0o644, flag: 'wx' });
  if (source) await writeFile(join(staging, 'docker.sources'), dockerSourcesFile(source, data), { mode: 0o644, flag: 'wx' });
  return staging;
}
