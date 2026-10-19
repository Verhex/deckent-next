import { DOCKER_APT, type DockerAptData } from './registry.js';

/** What the host showed before anything is offered (read-only probes; `desktop` is Docker Desktop seen from WSL or reported by detection). */
export type DockerHostFacts = Readonly<{ platform: 'linux' | 'wsl' | 'other'; osRelease: Readonly<Record<string, string>> | null; architecture: string | null;
  desktop: boolean; conflicts: readonly string[]; existingSource: string | null; network: boolean; user: string }>;
export type DockerInstallStep = Readonly<{ id: 'directory' | 'key' | 'sources' | 'update' | 'install' | 'group'; argv: readonly string[]; timeoutMs: number }>;
export type DockerPrintReason = 'platform' | 'desktop' | 'distribution' | 'conflicts' | 'repository' | 'network';
export type DockerSource = Readonly<{ distribution: string; codename: string; architecture: string; url: string }>;
/** `install`: the exact sudo steps the card shows and the executor runs; `print`: why Deckent only prints, with the steps when they are known. */
export type DockerInstallPlan = Readonly<{ kind: 'install'; source: DockerSource; steps: readonly DockerInstallStep[]; staging: string }>
  | Readonly<{ kind: 'print'; reason: DockerPrintReason; detail: string; source: DockerSource | null; steps: readonly DockerInstallStep[] | null; staging: string | null }>;

/** The supported repository for this release: the release's own ID only (Docker does not support derivatives), its codename and architecture. */
export function dockerSource(osRelease: DockerHostFacts['osRelease'], architecture: string | null, data: DockerAptData = DOCKER_APT): DockerSource | null {
  const entry = data.distributions.find(item => item.id === osRelease?.['ID']);
  const codename = entry?.codenameFields.map(field => osRelease?.[field]).find(value => value);
  if (!entry || !codename || !entry.codenames.includes(codename) || !architecture || !entry.architectures.includes(architecture)) return null;
  return { distribution: entry.id, codename, architecture, url: entry.url };
}
/** The deb822 source file Docker documents (one stable suite, signed by the shipped key only). */
export const dockerSourcesFile = (source: DockerSource, data: DockerAptData = DOCKER_APT) =>
  `Types: deb\nURIs: ${source.url}\nSuites: ${source.codename}\nComponents: stable\nArchitectures: ${source.architecture}\nSigned-By: ${data.keyring}\n`;
export const dockerSteps = (staging: string, user: string, data: DockerAptData = DOCKER_APT): readonly DockerInstallStep[] => Object.freeze([
  { id: 'directory', argv: ['install', '-m', '0755', '-d', data.keyring.slice(0, data.keyring.lastIndexOf('/'))], timeoutMs: data.timeoutsMs.directory },
  { id: 'key', argv: ['install', '-m', '0644', `${staging}/docker.asc`, data.keyring], timeoutMs: data.timeoutsMs.key },
  { id: 'sources', argv: ['install', '-m', '0644', `${staging}/docker.sources`, data.sourcesFile], timeoutMs: data.timeoutsMs.sources },
  { id: 'update', argv: ['apt-get', 'update'], timeoutMs: data.timeoutsMs.update },
  { id: 'install', argv: ['apt-get', 'install', '-y', ...data.packages], timeoutMs: data.timeoutsMs.install },
  { id: 'group', argv: ['usermod', '-aG', data.group, user], timeoutMs: data.timeoutsMs.group }] as const);
/** The commands as the person reads them (each argv token is a plain word: registry data, the staging path and the login name). */
export const dockerCommandLines = (steps: readonly DockerInstallStep[]) => steps.map(step => `sudo ${step.argv.join(' ')}`);

/**
 * Pure planner (INIT-D2 cond. 3/6): install only from Docker's official apt repository on a supported release; every other case prints the
 * honest next step: native Windows/macOS, Docker Desktop on WSL (its WSL integration, not a second engine), an unsupported or derivative
 * release, conflicting packages, an older Docker source file, or no network (the commands only, with the staged key and source files).
 */
export function planDockerInstall(facts: DockerHostFacts, staging: string | null, data: DockerAptData = DOCKER_APT): DockerInstallPlan {
  const source = facts.platform === 'other' ? null : dockerSource(facts.osRelease, facts.architecture, data);
  const steps = source && staging ? dockerSteps(staging, facts.user, data) : null, print = (reason: DockerPrintReason) => ({ kind: 'print' as const, reason,
    detail: reason === 'conflicts' ? facts.conflicts.join(' ') : reason === 'repository' ? facts.existingSource ?? '-' : '-', source, steps, staging });
  if (facts.platform === 'other') return print('platform');
  if (facts.desktop) return print('desktop');
  if (!source) return print('distribution');
  if (facts.conflicts.length) return print('conflicts');
  if (facts.existingSource) return print('repository');
  if (!facts.network || !steps || !staging) return print('network');
  return { kind: 'install', source, steps, staging };
}
