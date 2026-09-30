import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error Build tooling is native JavaScript, not a product TypeScript module.
import { syncPackageMetadata, metadataPath } from '../../../scripts/package-metadata.mjs';
const roots: string[] = [];
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
