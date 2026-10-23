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
  selfSource: (root: string) => Promise<boolean>; credential: ((id: string) => CodingCredentialSpec | null) | null; executable: (id: string) => string | null }>;
export const HOST_CODING_PORTS: CodingDetectPorts = Object.freeze({ run: runDetectCommand, find: findExecutable, credential: null,
  kind: (path: string) => lstat(path).then(info => info.isFile() ? 'file' as const : info.isDirectory() ? 'directory' as const : 'unknown' as const,
    (error: NodeJS.ErrnoException) => error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'absent' as const : 'unknown' as const),
  selfSource: (root: string) => isSelfSourceProject(root).catch(() => false),
  executable: (id: string) => { try { return nativeCliCommand(id as (typeof nativeCliIds)[number]).executable; } catch { return null; } } });

/**
 * The coding/git family's facts (I-S2): Git on PATH, a repository with commits, this build's own source checkout, configured work-target clones,
 * and the coding CLIs installed and holding a sign-in file ("found, not verified"). Read-only, bounded; no network, write or credential read.
 */
export async function detectCodingFacts(input: Readonly<{ root: string; env: DetectEnvironment; workTargets?: readonly string[]; ports?: Partial<CodingDetectPorts> }>): Promise<CodingFacts> {
  const ports = { ...HOST_CODING_PORTS, ...input.ports }, { git, limits } = registry, signal = AbortSignal.timeout(limits.totalTimeoutMs), root = resolve(input.root);
  const gitPath = await ports.find(git.executable, input.env, limits.pathDirectories, signal);
  const run = (path: string, args: readonly string[]) => ports.run(path, [...git.prefix, ...args], { env: git.env, cwd: root, timeoutMs: limits.commandTimeoutMs, outputBytes: limits.outputBytes, signal });
  const top = gitPath ? await run(gitPath, git.topLevelArgs) : null, head = gitPath && top?.code === 0 ? await run(gitPath, git.headArgs) : null;
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
    commits: !head ? 'not-run' : head.code === 0 ? 'present' : head.code === 1 ? 'none' : 'unknown',
    productSource: repository === 'present' && await ports.selfSource(root), workTargets: { configured: targets.length, present: present.filter(Boolean).length }, hosts };
}
