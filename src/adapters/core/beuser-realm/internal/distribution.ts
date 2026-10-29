import { constants } from 'node:fs';
import { lstat, readdir, open } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { PackageMeasurementLimits } from '#adapters/core/installation-artifacts/index.js';
import { sha256, REDACTION_PATTERNS, REDACTION_GATE_PATTERNS } from '#platform/index.js';
import { canonicalRealmPath } from './realm.js';

// Distribution admission uses credential rules; record redaction keeps its broader assignment classifier.
const distributionPatterns = [...REDACTION_PATTERNS.filter(row => row.gate), ...REDACTION_GATE_PATTERNS]
  .map(row => new RegExp('distributionSource' in row ? row.distributionSource : row.source, row.flags.replace('g', '')));
const hasDistributionCredential = (text: string): boolean => {
  const decoded = text.replace(/\\r\\n|\\[rn]/gu, '\n');
  return distributionPatterns.some(pattern => pattern.test(decoded));
};
/** The mounted tree includes dependencies: package.files measurement alone cannot certify those or reject extra host state. */
export async function verifyBeuserDistribution(root: string, files: readonly { readonly path: string; readonly sha256: string; readonly size: number }[],
  limits: PackageMeasurementLimits, digest: string): Promise<boolean> {
  if (sha256(JSON.stringify(files)) !== digest || !files.length || files.length > limits.maxFiles || new Set(files.map(file => file.path)).size !== files.length) return false;
  const allowed = new Map(files.map(file => [file.path, file])); let count = 0, total = 0;
  const visit = async (directory: string, depth: number): Promise<boolean> => {
    if (depth > limits.maxDepth) return false;
    for (const name of await readdir(directory)) {
      if (++count > limits.maxFiles || name.startsWith('.') || name === 'AGENTS.md' || name === 'CLAUDE.md' || /[\p{Cc}\p{Cs}]/u.test(name)) return false;
      const path = join(directory, name), info = await lstat(path);
      if (info.isSymbolicLink()) return false;
      if (info.isDirectory()) { if (!await visit(path, depth + 1)) return false; continue; }
      const expected = allowed.get(relative(root, path).split('\\').join('/'));
      if (!info.isFile() || info.nlink !== 1 || !expected || info.size !== expected.size || info.size > limits.maxFileBytes || (total += info.size) > limits.maxTotalBytes) return false;
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try { const before = await handle.stat(); if (before.dev !== info.dev || before.ino !== info.ino) return false;
        const bytes = await handle.readFile(), after = await handle.stat();
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || sha256(bytes) !== expected.sha256 || hasDistributionCredential(bytes.toString('utf8'))) return false;
      } finally { await handle.close(); }
      allowed.delete(relative(root, path).split('\\').join('/'));
    }
    return true;
  };
  await canonicalRealmPath(root, 'directory');
  return await visit(root, 0) && allowed.size === 0;
}
