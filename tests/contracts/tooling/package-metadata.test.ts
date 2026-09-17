import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error Build tooling is native JavaScript, not a product TypeScript module.
import { syncPackageMetadata, metadataPath } from '../../../scripts/package-metadata.mjs';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe('package identity build projection', () => {
  it('rejects stale metadata after a version change and regenerates only public identity fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-meta-')); roots.push(root);
    await mkdir(dirname(join(root, metadataPath)), { recursive: true });
    const manifest = { name: 'fixture', version: '1.0.0', engines: { node: '>=24' }, privateSettings: 'not-shipped' };
    await writeFile(join(root, 'package.json'), JSON.stringify(manifest));
    expect(() => syncPackageMetadata(root)).toThrow('PACKAGE_METADATA_STALE');
    syncPackageMetadata(root, true); expect(syncPackageMetadata(root)).toEqual({ name: 'fixture', version: '1.0.0', nodeEngine: '>=24' });
    manifest.version = '2.0.0'; await writeFile(join(root, 'package.json'), JSON.stringify(manifest));
    expect(() => syncPackageMetadata(root)).toThrow('PACKAGE_METADATA_STALE');
    syncPackageMetadata(root, true);
    expect(await readFile(join(root, metadataPath), 'utf8')).not.toContain('not-shipped');
    expect(syncPackageMetadata(root).version).toBe('2.0.0');
  });
});
