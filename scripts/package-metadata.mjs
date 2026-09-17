// Build-time projection; runtime modules import only the colocated pure JSON artifact.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const metadataPath = 'src/platform/core/common/internal/package-metadata.json';
export function syncPackageMetadata(root, write = false) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const metadata = { name: manifest.name, version: manifest.version, nodeEngine: manifest.engines?.node };
  if (Object.values(metadata).some(value => typeof value !== 'string' || !value.trim())) throw new Error('PACKAGE_METADATA_INVALID');
  const content = JSON.stringify(metadata, null, 2) + '\n';
  const target = join(root, metadataPath);
  if (write) writeFileSync(target, content);
  else if (!existsSync(target) || readFileSync(target, 'utf8') !== content) throw new Error('PACKAGE_METADATA_STALE: run node scripts/package-metadata.mjs --write');
  return metadata;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--write')) throw new Error('PACKAGE_METADATA_ARGUMENT_INVALID');
  syncPackageMetadata(dirname(dirname(fileURLToPath(import.meta.url))), args[0] === '--write');
}
