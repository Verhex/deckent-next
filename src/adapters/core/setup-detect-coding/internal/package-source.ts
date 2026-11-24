import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import type { VerifiedPrincipal } from '#domain/index.js';
import { gitCommittedInputSource, resolveGitWorkTarget, selectWorkTarget } from '#adapters/core/git-workspace/index.js';
import { authorizeWorkTargetUse, type PackageKnownSecrets, type PolicySource } from '#engine/index.js';
import { ErrorRegistry, loadConfig, prepareProductDirectory, withConfigWriteLock, type ConfigLoadOptions, type DeckentConfig, type ProductLayout } from '#platform/index.js';
import { codingPreparedInput, produceCodingPackageList } from './prepared-input.js';

type Context = Readonly<{ config: DeckentConfig; layout: ProductLayout; installationLayout: ProductLayout; principal: VerifiedPrincipal }>;
type HostPorts = Readonly<{
  policy: () => PolicySource;
  captureSecrets: () => Promise<{ known: PackageKnownSecrets; withCurrent<T>(work: () => Promise<T>): Promise<T> }>;
}>;
type Layout = Readonly<{ source: string; lockfile: string; fileList: string; mount: string }>;

/** Resolve the same scoped Git target used by the Attempt checkout. Capture its fixed commit's blob. */
async function packageSource(root: string, context: Context, scopeId: string, layout: Layout, policy: HostPorts['policy'], pinnedCommit?: string) {
  const execution = context.config.execution;
  if (!execution || process.platform !== 'linux') throw ErrorRegistry.createError('NATIVE_WORKER_DEPENDENCIES_REFUSED');
  await authorizeWorkTargetUse(policy(), selectWorkTarget(execution)?.id ?? null, scopeId, context.principal);
  const project = await realpath(resolve(root)), target = await resolveGitWorkTarget(project, execution, context.layout);
  const workTarget = target.git.sourceRoot, lock = gitCommittedInputSource(execution.git, workTarget, pinnedCommit ?? target.baseCommit ?? 'HEAD');
  const file = await lock.read(layout.lockfile, execution.secretGate.maxFileBytes).catch(() => null);
  if (!file) throw ErrorRegistry.createError('NATIVE_WORKER_LOCKFILE_CHANGED');
  const lockfileDigest = createHash('sha256').update(file.bytes).digest('hex');
  const cache = context.config.installation.npmPackageCache ?? join(userInfo().homedir, '.npm', '_cacache');
  return { project, workTarget, execution, file, lockfileDigest, cache, platform: `${process.platform}-${process.arch}` };
}

export async function openPreparedPackageInput(root: string, context: Context, scopeId: string, layout: Layout, pinnedCommit: string | undefined,
  options: ConfigLoadOptions, host: HostPorts, reviewSecrets?: PackageKnownSecrets) {
  const { project, workTarget, execution, file, lockfileDigest, cache, platform } = await packageSource(root, context, scopeId, layout, host.policy, pinnedCommit);
  const list = await gitCommittedInputSource(execution.git, workTarget, file.commit).read(layout.fileList, execution.secretGate.maxFileBytes).catch(() => null);
  if (!list)
    throw ErrorRegistry.createError('NATIVE_WORKER_DEPENDENCIES_REFUSED');
  const { known, withCurrent } = reviewSecrets === undefined ? await host.captureSecrets()
    : { known: reviewSecrets, withCurrent: undefined };
  const source = await codingPreparedInput(workTarget, layout.source, layout.mount, execution.secretGate, known, file.bytes, list.bytes, cache, project);
  return { project, workTarget, lockfileDigest, platform, known, review: source.review,
    withCurrentSecrets: withCurrent ?? (async <T>(work: () => Promise<T>) => work()),
    async assertCurrent() {
      const current = await packageSource(root, context, scopeId, layout, host.policy);
      if (current.workTarget !== workTarget || current.file.commit !== file.commit)
        throw ErrorRegistry.createError('NATIVE_WORKER_LOCKFILE_CHANGED');
    },
    async seal(reference: Parameters<typeof source.seal>[1]) {
      return source.seal(await prepareProductDirectory(context.installationLayout, 'artifacts'), reference, {
        run: (store, work) => withConfigWriteLock(store, work, execution.secretGate.timeoutMs),
        async maxBytes() {
          const fresh = await loadConfig(root, { ...options, heal: false, force: true });
          return fresh.installation.sealedPackageStoreMaxBytes;
        },
      });
    } };
}

export async function writePreparedPackageList(root: string, context: Context, scopeId: string, layout: Layout, host: HostPorts, cachePath?: string) {
  const { project, workTarget, execution, file, lockfileDigest, cache, platform } = await packageSource(root, context, scopeId, layout, host.policy);
  const { known, withCurrent } = await host.captureSecrets();
  const produced = await produceCodingPackageList(workTarget, layout.source, layout.mount, execution.secretGate, known,
    file.bytes, cachePath === undefined ? cache : resolve(root, cachePath), project);
  const fresh = await packageSource(root, context, scopeId, layout, host.policy);
  if (fresh.workTarget !== workTarget || fresh.file.commit !== file.commit) throw ErrorRegistry.createError('NATIVE_WORKER_LOCKFILE_CHANGED');
  return withCurrent(async () => {
    await produced.write(layout.fileList);
    return { kind: 'prepared' as const, written: layout.fileList, project, workTarget, lockfileDigest, platform, layout,
      listDigest: produced.review.digest, manifest: produced.review.manifest };
  });
}

export async function packageTargetIdentity(path: string) {
  const target = await lstat(path, { bigint: true });
  return { isDirectory: target.isDirectory(), device: String(target.dev), inode: String(target.ino) };
}
