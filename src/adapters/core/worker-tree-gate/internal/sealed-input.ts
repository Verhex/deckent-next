import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { NATIVE_NODE_DEPENDENCY_LAYOUT as profile, type NativeNodeDependencyReference } from '#domain/index.js';
import { gitInputMountTracked } from '#adapters/core/git-workspace/index.js';
import { ErrorRegistry, productResourcePath, sha256, type DeckentConfig, type ProductLayout } from '#platform/index.js';
import { type WorkerTreeKnownSecrets } from './scan.js';
import { reopenWorkerTree, sealedWorkerTreeLocation, verifySealedWorkerTree } from './sealed-tree.js';

const refused = () => ErrorRegistry.createError('NATIVE_WORKER_DEPENDENCIES_REFUSED');
const read = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export async function openSealedNativeInput(reference: NativeNodeDependencyReference, input: Readonly<{ root: string; workTarget: string; checkout: string;
  scopeId: string; config: DeckentConfig; layout: ProductLayout }>) {
  const { config, checkout } = input, execution = config.execution;
  if (!execution || reference.layout !== profile.id || reference.approval.scopeId !== input.scopeId || reference.platform !== `${process.platform}-${process.arch}`
    || reference.project !== await realpath(input.root) || reference.workTarget !== await realpath(input.workTarget)) throw refused();
  const target = join(checkout, profile.mount), lockfile = join(checkout, profile.lockfile), { secretGate: limits } = execution;
  if (await gitInputMountTracked(execution.git, checkout, profile.mount).catch(() => true)) throw refused();
  async function validateLockfile() {
    try {
      const file = await open(lockfile, read);
      try {
        const before = await file.stat({ bigint: true });
        if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(limits.maxFileBytes)) throw refused();
        const size = Number(before.size), contents = Buffer.alloc(size);
        let offset = 0;
        while (offset < contents.length) {
          const { bytesRead } = await file.read(contents, offset, contents.length - offset, offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        const after = await file.stat({ bigint: true }), named = await lstat(lockfile, { bigint: true });
        if (offset !== size || after.size !== before.size || after.ctimeNs !== before.ctimeNs || named.ctimeNs !== after.ctimeNs || named.dev !== after.dev || named.ino !== after.ino
          || sha256(contents.subarray(0, offset)) !== reference.lockfileDigest) throw refused();
      } finally { await file.close(); }
    } catch { throw ErrorRegistry.createError('NATIVE_WORKER_LOCKFILE_CHANGED'); }
  }
  await validateLockfile();
  try { await mkdir(target, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw refused(); }
  const mount = await lstat(target, { bigint: true });
  const validateMount = async () => {
    try {
      const current = await lstat(target, { bigint: true });
      if (!current.isDirectory() || current.dev !== mount.dev || current.ino !== mount.ino || current.ctimeNs !== mount.ctimeNs ||
        await realpath(target) !== target || (await readdir(target)).length !== 0) throw refused();
    } catch { throw refused(); }
  };
  await validateMount();
  const object = sealedWorkerTreeLocation(productResourcePath(input.layout, 'artifacts'), reference);
  const { source, digest, entries } = await verifySealedWorkerTree(object, reference.listDigest, limits);
  const objectStat = await lstat(source, { bigint: true });
  const scanView = Object.freeze({ source, label: profile.mount, sealedPatterns: Object.freeze({ entries: Object.freeze(entries) }) });
  return Object.freeze({ source, target, digest, lockfile, scanView, async validate() {
    await validateMount(); await validateLockfile();
    const now = await lstat(source, { bigint: true }).catch(() => { throw refused(); });
    if (!now.isDirectory() || now.dev !== objectStat.dev || now.ino !== objectStat.ino || now.ctimeNs !== objectStat.ctimeNs) throw refused();
  } });
}

export async function verifyPackageObject(context: Readonly<{ config: DeckentConfig; installationLayout: ProductLayout }>,
  reference: NativeNodeDependencyReference, known: WorkerTreeKnownSecrets) {
  if (!context.config.execution) throw refused();
  const limits = context.config.execution.secretGate, object = sealedWorkerTreeLocation(productResourcePath(context.installationLayout, 'artifacts'), reference);
  const { source } = await reopenWorkerTree(object, profile.mount, reference.listDigest, limits, known);
  const identity = await lstat(source, { bigint: true });
  return async () => {
    const checked = await verifySealedWorkerTree(object, reference.listDigest, limits);
    const fresh = await lstat(checked.source, { bigint: true });
    if (checked.source !== source || fresh.dev !== identity.dev || fresh.ino !== identity.ino || fresh.ctimeNs !== identity.ctimeNs) throw refused();
  };
}

