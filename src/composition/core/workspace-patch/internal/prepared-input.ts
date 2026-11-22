import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { codingPreparedInput, produceCodingPackageList, gitCommittedInputSource, resolveGitWorkTarget, selectWorkTarget } from '#adapters/index.js';
import { authorizeWorkTargetUse } from '#engine/index.js';
import { ErrorRegistry, getConfigKnownSecrets, loadConfig, prepareProductDirectory, withConfigWriteLock, type ConfigLoadOptions, type KnownSecretSnapshot } from '#platform/index.js';
import { contextPolicySource } from '#composition/core/policy/index.js';
import type { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';

type Context = Awaited<ReturnType<typeof loadConfiguredScopeContext>>;
type Layout = Readonly<{ source: string; lockfile: string; fileList: string; mount: string }>;

/** Resolve the same scoped Git target used by the Attempt checkout. Capture its fixed commit's blob. */
async function packageSource(root: string, context: Context, scopeId: string, layout: Layout, pinnedCommit?: string) {
  const execution = context.config.execution;
  if (!execution || process.platform !== 'linux') throw ErrorRegistry.createError('NATIVE_WORKER_DEPENDENCIES_REFUSED');
  await authorizeWorkTargetUse(contextPolicySource(context), selectWorkTarget(execution)?.id ?? null, scopeId, context.principal);
  const project = await realpath(resolve(root)), target = await resolveGitWorkTarget(project, execution, context.layout);
  const workTarget = target.git.sourceRoot, lock = gitCommittedInputSource(execution.git, workTarget, pinnedCommit ?? target.baseCommit ?? 'HEAD');
  const file = await lock.read(layout.lockfile, execution.secretGate.maxFileBytes).catch(() => null);
  if (!file) throw ErrorRegistry.createError('NATIVE_WORKER_LOCKFILE_CHANGED');
  const lockfileDigest = createHash('sha256').update(file.bytes).digest('hex'), known = getConfigKnownSecrets(context.config);
  const cache = context.config.installation.npmPackageCache ?? join(userInfo().homedir, '.npm', '_cacache');
  return { project, workTarget, execution, file, lockfileDigest, known, cache, platform: `${process.platform}-${process.arch}` };
}

export async function configuredPreparedInput(root: string, context: Context, scopeId: string, layout: Layout, pinnedCommit?: string,
  options: ConfigLoadOptions = {}, reviewSecrets?: KnownSecretSnapshot) {
  const { project, workTarget, execution, file, lockfileDigest, known, cache, platform } = await packageSource(root, context, scopeId, layout, pinnedCommit);
  const list = await gitCommittedInputSource(execution.git, workTarget, file.commit).read(layout.fileList, execution.secretGate.maxFileBytes).catch(() => null);
  if (!list)
    throw ErrorRegistry.createError('NATIVE_WORKER_DEPENDENCIES_REFUSED');
  const source = await codingPreparedInput(workTarget, layout.source, layout.mount, execution.secretGate, reviewSecrets ?? known, file.bytes, list.bytes, cache, project);
  return { project, workTarget, lockfileDigest, platform, review: source.review,
    async assertCurrent() {
      const current = await packageSource(root, context, scopeId, layout);
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

export async function configuredPackageList(root: string, context: Context, scopeId: string, layout: Layout, cachePath?: string) {
  const { project, workTarget, execution, file, lockfileDigest, known, cache, platform } = await packageSource(root, context, scopeId, layout);
  const produced = await produceCodingPackageList(workTarget, layout.source, layout.mount, execution.secretGate, known,
    file.bytes, cachePath === undefined ? cache : resolve(root, cachePath), project);
  const fresh = await packageSource(root, context, scopeId, layout);
  if (fresh.workTarget !== workTarget || fresh.file.commit !== file.commit) throw ErrorRegistry.createError('NATIVE_WORKER_LOCKFILE_CHANGED');
  await produced.write(layout.fileList);
  return { kind: 'prepared' as const, written: layout.fileList, project, workTarget, lockfileDigest, platform, layout,
    listDigest: produced.review.digest, manifest: produced.review.manifest };
}
