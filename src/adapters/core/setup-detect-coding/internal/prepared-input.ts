import { ErrorRegistry, redactForRecord } from '#platform/index.js';
import { join } from 'node:path';
import { reviewSealedWorkerTree, sealWorkerTree, sealedWorkerTreeLocation, writePreparedInputFile } from '#adapters/core/worker-tree-gate/index.js';
import { cachedNpmInventory } from './npm-archive.js';
import { npmPackageSelection } from './npm-package-list.js';
import { makeNpmPackageList } from './npm-package-producer.js';

/** Resolve exact package files from the person's inventory and the committed lock for this work target. */
export async function codingPreparedInput(target: string, relative: string, label: string, options: Parameters<typeof sealWorkerTree>[4], known: Parameters<typeof sealWorkerTree>[5],
  lockfile: Buffer, list: Buffer, cache: string, project: string) {
  return preparedInput(target, relative, label, options, known, lockfile, list, cachedNpmInventory(cache, options, known), project);
}

async function preparedInput(target: string, relative: string, label: string, options: Parameters<typeof sealWorkerTree>[4], known: Parameters<typeof sealWorkerTree>[5],
  lockfile: Buffer, list: Buffer, archive: ReturnType<typeof cachedNpmInventory>, project: string) {
  if ([project, target].some(path => redactForRecord(path, known) !== path || /[\p{Cc}\p{Cf}]/u.test(path)))
    throw ErrorRegistry.createError('NATIVE_WORKER_DEPENDENCIES_REFUSED');
  const source = join(target, relative), selection = await npmPackageSelection(relative, lockfile, list, options.maxFiles, archive);
  return { review: () => reviewSealedWorkerTree(source, label, options, known, selection),
    seal: (artifacts: string, identity: Parameters<typeof sealedWorkerTreeLocation>[1], capacity?: Parameters<typeof sealWorkerTree>[7]) =>
      sealWorkerTree(source, sealedWorkerTreeLocation(artifacts, identity), label, identity.listDigest, options, known, selection, capacity) };
}

export async function produceCodingPackageList(target: string, relative: string, label: string, options: Parameters<typeof sealWorkerTree>[4],
  known: Parameters<typeof sealWorkerTree>[5], lockfile: Buffer, cache: string, project: string) {
  const archive = cachedNpmInventory(cache, options, known);
  const bytes = await makeNpmPackageList(join(target, relative), relative, lockfile, options.maxFiles, options.maxFileBytes, archive);
  const input = await preparedInput(target, relative, label, options, known, lockfile, bytes, archive, project);
  return { bytes, review: await input.review(), write: (name: string) => writePreparedInputFile(join(target, name), bytes, options.maxFileBytes) };
}
