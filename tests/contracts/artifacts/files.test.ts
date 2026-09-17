import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileArtifactStore } from '#adapters/index.js';
import { clearConfigCache } from '#platform/index.js';
import { openConfiguredArtifactStore } from '../../../src/composition/core/artifacts/index.js';
const roots: string[] = [];
const scopePath = (root: string, scope: string) => join(root, createHash('sha256').update(scope).digest('hex'));
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-artifact-')); roots.push(root);
  const path = join(root, 'artifacts'); await mkdir(path, { mode: 0o700 });
  return { root, path, store: new FileArtifactStore({ root: path, maxBytes: 1024 }) };
}
describe.skipIf(process.platform === 'win32')('scoped persistent artifacts', () => {
  it('persists binary content across reopen with private permissions, digest and scope checks', async () => {
    const f = await fixture(); const bytes = new Uint8Array([0, 255, 13, 10, 42]);
    const receipt = await f.store.put('customer-a', bytes);
    const reopened = new FileArtifactStore({ root: f.path, maxBytes: 1024 });
    expect([...await reopened.read('customer-a', receipt)]).toEqual([...bytes]);
    expect((await stat(join(scopePath(f.path, 'customer-a'), receipt.digest))).mode & 0o777).toBe(0o600);
    await expect(reopened.read('customer-b', receipt)).rejects.toThrow('ARTIFACT_SCOPE_DENIED');
    await expect(reopened.read('customer-b', { ...receipt, scopeId: 'customer-b' })).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await reopened.put('customer-a', bytes)).toEqual(receipt);
  });
  it('handles concurrent identical publication and empty content without partial readable files', async () => {
    const f = await fixture(); const bytes = Buffer.from('same-content');
    const receipts = await Promise.all(Array.from({ length: 8 }, () => f.store.put('s', bytes)));
    expect(new Set(receipts.map(x => x.digest)).size).toBe(1);
    expect(Buffer.from(await f.store.read('s', receipts[0]!)).toString()).toBe('same-content');
    const empty = await f.store.put('s', new Uint8Array()); expect((await f.store.read('s', empty)).length).toBe(0);
  });
  it('detects tampering and symlink substitution without following outside content', async () => {
    const f = await fixture(); const receipt = await f.store.put('s', Buffer.from('original'));
    const path = join(scopePath(f.path, 's'), receipt.digest); await writeFile(path, 'tampered');
    await expect(f.store.read('s', receipt)).rejects.toThrow('ARTIFACT_CORRUPT');
    await expect(f.store.put('s', Buffer.from('original'))).rejects.toThrow('ARTIFACT_CORRUPT');
    await rm(path); const outside = join(f.root, 'sentinel'); await writeFile(outside, 'outside'); await symlink(outside, path);
    await expect(f.store.read('s', receipt)).rejects.toThrow('ARTIFACT_UNSAFE');
    expect(await readFile(outside, 'utf8')).toBe('outside');
  });
  it('rejects oversize before scope creation and rejects linked scope directories', async () => {
    const f = await fixture(); await expect(f.store.put('s', new Uint8Array(1025))).rejects.toThrow('ARTIFACT_TOO_LARGE');
    await expect(stat(scopePath(f.path, 's'))).rejects.toMatchObject({ code: 'ENOENT' });
    const outside = join(f.root, 'outside'); await mkdir(outside); await symlink(outside, scopePath(f.path, 's'));
    await expect(f.store.put('s', Buffer.from('x'))).rejects.toThrow('ARTIFACT_UNSAFE');
  });
  it('uses configured relocated artifact path while the project locator remains fixed', async () => {
    const f = await fixture(); const project = join(f.root, 'project'); await mkdir(join(project, '.deckent'), { recursive: true });
    const data = join(f.root, 'data'); await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data, resources: { artifacts: 'retained/bytes' } } }));
    const opened = await openConfiguredArtifactStore(project, 1024, { env: { HOME: join(f.root, 'home') } });
    expect(opened.path).toBe(join(data, 'retained/bytes'));
    const receipt = await opened.store.put('s', Buffer.from('persisted'));
    expect(Buffer.from(await opened.store.read('s', receipt)).toString()).toBe('persisted');
    expect(opened.layout.bootstrapConfigPath).toBe(join(project, '.deckent/config.json'));
  });
});
