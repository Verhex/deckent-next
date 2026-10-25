import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error Build tooling is native JavaScript, not a product TypeScript module.
import { syncPackageMetadata, metadataPath } from '../../../scripts/package-metadata.mjs';
// @ts-expect-error Build tooling is native JavaScript, not a product TypeScript module.
import { workerLineage } from '../../../scripts/build-worker-lineage.mjs';
const roots: string[] = [];
it('refuses packaging a changed recipe without an appended lineage entry and a matching lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-worker-lineage-')); roots.push(root);
  const folder = join(root, 'assets/worker-image'); await mkdir(folder, { recursive: true });
  const recipe = { imageVersion: 'r4-20260930', providers: [{ id: 'fixture' }] };
  await writeFile(join(folder, 'recipe.json'), JSON.stringify(recipe));
  workerLineage(root, true);
  const before = await readFile(join(folder, 'lineage.json'), 'utf8');
  expect(workerLineage(root).recipes).toHaveLength(1);
  await writeFile(join(folder, 'recipe.json'), JSON.stringify({ ...recipe, imageVersion: 'r5-20261025' }));
  expect(() => workerLineage(root)).toThrow('WORKER_LINEAGE_INVALID');
  workerLineage(root, true);
  expect(workerLineage(root).recipes).toHaveLength(2);
  expect((await readFile(join(folder, 'lineage.json'), 'utf8'))).toContain(JSON.parse(before).recipes[0].sha256);
  await writeFile(join(folder, 'lineage.lock.json'), JSON.stringify({ sha256: '0'.repeat(64) }));
  expect(() => workerLineage(root)).toThrow('WORKER_LINEAGE_INVALID');
});
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe('package identity build projection', () => {
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'deckent-meta-')); roots.push(root);
    await mkdir(dirname(join(root, metadataPath)), { recursive: true });
    const manifest = { name: 'fixture', version: '1.0.0', engines: { node: '>=24' } };
    await writeFile(join(root, 'package.json'), JSON.stringify(manifest));
    syncPackageMetadata(root, true);
    const content = await readFile(join(root, metadataPath), 'utf8');
    return { root, content };
  }

  it('accepts CRLF checkout text without rewriting it and keeps generation canonical LF', async () => {
    const { root, content } = await fixture();
    expect(content).not.toContain('\r');
    const checkout = content.replace(/\n/g, '\r\n');
    await writeFile(join(root, metadataPath), checkout);
    expect(syncPackageMetadata(root)).toEqual({ name: 'fixture', version: '1.0.0', nodeEngine: '>=24' });
    expect(await readFile(join(root, metadataPath), 'utf8')).toBe(checkout);
    syncPackageMetadata(root, true);
    expect(await readFile(join(root, metadataPath), 'utf8')).toBe(content);
  });

  for (const eol of ['\n', '\r\n']) {
    it.each([
      ['name', 'old-package'], ['version', '0.9.0'], ['nodeEngine', '>=22'],
    ])(`rejects stale %s with ${eol === '\n' ? 'LF' : 'CRLF'} without repairing it`, async (field, staleValue) => {
      const { root, content } = await fixture();
      const stale = JSON.stringify({ ...JSON.parse(content), [field]: staleValue }, null, 2).replace(/\n/g, eol) + eol;
      await writeFile(join(root, metadataPath), stale);
      expect(() => syncPackageMetadata(root)).toThrow('PACKAGE_METADATA_STALE');
      expect(await readFile(join(root, metadataPath), 'utf8')).toBe(stale);
    });
  }

  it.each(['lone CR', 'trailing space', 'BOM', 'missing newline', 'extra field'])(
    'does not normalize %s', async kind => {
      const { root, content } = await fixture();
      const changed = kind === 'lone CR' ? content.replace(/\n/g, '\r')
        : kind === 'trailing space' ? content.replace(/\n/g, ' \n')
        : kind === 'BOM' ? '\uFEFF' + content
        : kind === 'missing newline' ? content.slice(0, -1)
        : content.replace('"name":', '"extra": true,\n  "name":');
      await writeFile(join(root, metadataPath), changed);
      expect(() => syncPackageMetadata(root)).toThrow('PACKAGE_METADATA_STALE');
    },
  );

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
