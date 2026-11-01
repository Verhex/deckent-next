import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { beuserCandidateManifestSchema, type BeuserCandidateManifest } from '#domain/index.js';
import { BeuserContractError } from '#engine/index.js';
import { sha256 } from '#platform/index.js';
import { measureInstalledPackage, type PackageMeasurementLimits, type MeasuredPackageFile } from '#adapters/core/installation-artifacts/index.js';
import { verifyBeuserDistribution } from './distribution.js';

const mismatch = (): never => { throw new BeuserContractError('BEUSER_CANDIDATE_MISMATCH'); };
/** Read only bytes pinned by the bounded package measurement; never allocate from a new file's size. */
export async function readMeasuredBeuserRecord(root: string, file: MeasuredPackageFile | undefined): Promise<Record<string, unknown>> {
  if (!file || constants.O_NOFOLLOW === undefined || constants.O_NONBLOCK === undefined) return mismatch();
  const handle = await open(join(root, file.path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => mismatch());
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== file.size) return mismatch();
    const bytes = Buffer.alloc(file.size); let offset = 0;
    while (offset < bytes.length) { const part = await handle.read(bytes, offset, bytes.length - offset, offset); if (!part.bytesRead) break; offset += part.bytesRead; }
    if (offset !== bytes.length || sha256(bytes) !== file.sha256) return mismatch();
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return mismatch();
    return value as Record<string, unknown>;
  } finally { await handle.close(); }
}
/** Shared setup/walk/realm admission: reload the full inventory and preserve every existing distribution check. */
export async function readBeuserCandidate(root: string, reference: BeuserCandidateManifest, limits: PackageMeasurementLimits,
  packageDigest: string, distributionDigest: string) {
  try {
    const pin = beuserCandidateManifestSchema.parse(reference), measured = await measureInstalledPackage(root, limits);
    if (measured.files.find(file => file.path === 'manifest.json')?.sha256 !== pin.sha256
      || measured.files.length !== pin.fileCount || measured.packageVersion !== pin.version
      || measured.measurementDigest !== packageDigest || measured.declaredMissing.length) return mismatch();
    const release = await readMeasuredBeuserRecord(root, measured.files.find(file => file.path === 'release.json'));
    const build = await readMeasuredBeuserRecord(root, measured.files.find(file => file.path === 'dist/build-identity.json'));
    if (release['sourceCommit'] !== pin.sourceCommit || release['sourceTreeSha256'] !== pin.sourceTreeSha256
      || build['sourceCommit'] !== pin.sourceCommit || build['sourceTreeSha256'] !== pin.sourceTreeSha256) return mismatch();
    const files = measured.files.map(({ path, sha256, size }) => ({ path, sha256, size }));
    if (!await verifyBeuserDistribution(root, files, limits, distributionDigest)) return mismatch();
    return measured;
  } catch { return mismatch(); }
}
