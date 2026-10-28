import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { nativeCliIds } from '#domain/index.js';
import { nativeCliCommand } from '#adapters/core/native-cli-registry/index.js';
import { isSelfSourceProject } from '#adapters/core/agent-workspace-floor/index.js';
import { findExecutable, runDetectCommand, type DetectEnvironment, type DetectRunner } from '#adapters/core/setup-detect-execution/index.js';
import type { CodingFacts } from './family.js';
import registry from './coding.json' with { type: 'json' };
/** Where a coding CLI keeps its sign-in (the native connection catalog's shape); `homeOverride` names an environment variable that moves it. */
export type CodingCredentialSpec = Readonly<{ homeOverride: string; home: string; file: string }>;
export type PathKind = 'file' | 'directory' | 'absent' | 'unknown';
/** Read-only host ports. `kind` is the only access to sign-in files: an lstat, never an open or a read (ANALYSIS §11: stat only). */
export type CodingDetectPorts = Readonly<{ run: DetectRunner; find: typeof findExecutable; kind: (path: string) => Promise<PathKind>;
  selfSource: (root: string) => Promise<boolean>; owned: (path: string) => Promise<boolean>; credential: ((id: string) => CodingCredentialSpec | null) | null; executable: (id: string) => string | null }>;
export const HOST_CODING_PORTS: CodingDetectPorts = Object.freeze({ run: runDetectCommand, find: findExecutable, credential: null,
  kind: (path: string) => lstat(path).then(info => info.isFile() ? 'file' as const : info.isDirectory() ? 'directory' as const : 'unknown' as const,
    (error: NodeJS.ErrnoException) => error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'absent' as const : 'unknown' as const),
  selfSource: (root: string) => isSelfSourceProject(root).catch(() => false),
  owned: (path: string) => lstat(path).then(info => info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid?.() && (info.mode & 0o022) === 0, () => false),
  executable: (id: string) => { try { return nativeCliCommand(id as (typeof nativeCliIds)[number]).executable; } catch { return null; } } });
/** BeUser M-32 / Astra R1-K5: uncommitted paths (tracked + untracked) with a stat signature each; read-only, owned folder only; repository filters, fsmonitor, external diff and submodules never run. */
export async function workingTreeChanges(root: string, env: DetectEnvironment, overrides: Partial<CodingDetectPorts> = {}, known?: string | null, signal = AbortSignal.timeout(registry.limits.totalTimeoutMs)): Promise<Readonly<{ state: 'present' | 'none' | 'unknown'; files: ReadonlyMap<string, string> }>> {
  const ports = { ...HOST_CODING_PORTS, ...overrides }, { git, limits } = registry, unknown = { state: 'unknown' as const, files: new Map<string, string>() }, gitPath = known ?? await ports.find(git.executable, env, limits.pathDirectories, signal);
  const run = (args: readonly string[]) => ports.run(gitPath!, [...git.prefix, ...args], { env: git.env, cwd: root, timeoutMs: limits.commandTimeoutMs, outputBytes: limits.outputBytes, signal });
  const listed = gitPath && await ports.owned(root) ? await run(git.filterListArgs) : null, drivers = [...new Set(listed?.stdout.split('\0').filter(Boolean).map(key => /^filter\.(.+)\.(?:clean|process|smudge)$/su.exec(key)?.[1] ?? '') ?? [])];
  if (!listed || listed.code !== 0 && listed.code !== 1 || drivers.length > git.maxFilterDrivers || drivers.includes('')) return unknown;
  const config = [...git.changeConfig, ...drivers.flatMap(name => ['clean', 'process', 'smudge'].flatMap(part => ['-c', `filter.${name}.${part}=`]).concat(['-c', `filter.${name}.required=false`]))];
  const tracked = await run([...config, ...git.trackedArgs]), untracked = tracked.code === 0 ? await run([...config, ...git.untrackedArgs]) : null; if (!untracked || untracked.code !== 0) return unknown;
  const paths = [...new Set([...tracked.stdout.split('\0'), ...untracked.stdout.split('\0')].filter(Boolean))], files = new Map<string, string>();
  for (const path of paths) files.set(path, await lstat(join(root, path)).then(info => `${info.size}:${info.mtimeMs}`, () => 'deleted')); return { state: paths.length ? 'present' : 'none', files };
}
/**
 * The coding/git family's facts (I-S2): Git on PATH, a repository with commits, this build's own source checkout, configured work-target clones,
 * and the coding CLIs installed and holding a sign-in file ("found, not verified"). Read-only, bounded; no network, write or credential read.
 */
export async function detectCodingFacts(input: Readonly<{ root: string; env: DetectEnvironment; workTargets?: readonly string[]; ports?: Partial<CodingDetectPorts> }>): Promise<CodingFacts> {
  const ports = { ...HOST_CODING_PORTS, ...input.ports }, { git, limits } = registry, signal = AbortSignal.timeout(limits.totalTimeoutMs), root = resolve(input.root);
  const gitPath = await ports.find(git.executable, input.env, limits.pathDirectories, signal);
  const run = (path: string, args: readonly string[]) => ports.run(path, [...git.prefix, ...args], { env: git.env, cwd: root, timeoutMs: limits.commandTimeoutMs, outputBytes: limits.outputBytes, signal });
  const top = gitPath ? await run(gitPath, git.topLevelArgs) : null, head = gitPath && top?.code === 0 ? await run(gitPath, git.headArgs) : null;
  const changes = async () => !gitPath || top?.code !== 0 || head?.code !== 0 ? 'not-run' as const : (await workingTreeChanges(root, input.env, ports, gitPath, signal)).state;
  const gitVersion = gitPath ? /(\d+\.\d+[0-9A-Za-z.+~_-]{0,48})/u.exec((await run(gitPath, git.versionArgs)).stdout)?.[1] ?? null : null;
  const repository = !top ? 'not-run' : top.code === 0 ? 'present' : top.code !== null && top.stderr.includes(git.notRepository) ? 'none' : 'unknown';
  const targets = (input.workTargets ?? []).slice(0, limits.workTargets).map(path => resolve(root, path)).filter(path => path !== root);
  const present = await Promise.all(targets.map(async path => await ports.kind(path) === 'directory' && await ports.kind(join(path, '.git')) !== 'absent'));
  const home = input.env['HOME'] || homedir(), hosts: CodingFacts['hosts'][number][] = [];
  for (const id of nativeCliIds.slice(0, limits.hosts)) {
    const executable = ports.executable(id), spec = ports.credential?.(id) ?? null, override = spec?.homeOverride ? input.env[spec.homeOverride] : undefined;
    const login = spec ? await ports.kind(join(override && isAbsolute(override) ? override : join(home, spec.home), spec.file)) : 'unknown';
    hosts.push({ id, cli: !executable ? 'unknown' : await ports.find(executable, input.env, limits.pathDirectories, signal) ? 'found' : 'absent',
      login: login === 'file' ? 'found' : login === 'absent' ? 'absent' : 'unknown' });
  }
  return { schemaVersion: 1, git: gitPath ? 'found' : signal.aborted ? 'unknown' : 'absent', gitPath, gitVersion, repository,
    commits: !head ? 'not-run' : head.code === 0 ? 'present' : head.code === 1 ? 'none' : 'unknown', changes: await changes(),
    productSource: repository === 'present' && await ports.selfSource(root), workTargets: { configured: targets.length, present: present.filter(Boolean).length }, hosts };
}
