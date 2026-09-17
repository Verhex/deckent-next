import { mkdtemp, mkdir, writeFile, rm, rename, chmod, symlink, link, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { FilePolicySource } from '#adapters/index.js';
import { DispatchPolicyAuthorization } from '#engine/index.js';
import { resolveProductLayout } from '#platform/index.js';
import { createLayoutPolicySource } from '../../../src/composition/core/policy/index.js';
const roots: string[] = [];
const principal = { id: 'user', issuer: 'host', subject: '1', assurance: 'os-user' as const, scopeIds: ['s'] };
const request = { protocolVersion: 1 as const, identity: { runId: 'r', taskId: 't', attemptId: 'a', scopeId: 's', generation: 1, layoutRevision: 'l' }, workspace: '/workspace', argv: ['tool'] };
const policy = { schemaVersion: 1, revision: 'initial', restrictions: [], grants: [{ id: 'owner', effect: 'allow', actions: ['execute'], scopes: ['s'],
  principals: [{ issuer: 'host', subject: '1' }], resource: { kind: 'attempt', ids: ['a'] } }] };
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-policy-source-')); roots.push(root);
  const path = join(root, 'policy.json'); await writeFile(path, JSON.stringify(policy), { mode: 0o600 });
  const source = new FilePolicySource({ path, ownerUid: process.getuid!(), maxBytes: 4096 });
  return { root, path, source };
}
describe.skipIf(process.platform === 'win32')('trusted local policy file', () => {
  it('rereads atomic revocation and never creates missing authority or falls back to cached grants', async () => {
    const f = await fixture(); const gate = new DispatchPolicyAuthorization(f.source);
    await expect(gate.authorize('execute', request, principal)).resolves.toBeUndefined();
    const replacement = join(f.root, 'next'); await writeFile(replacement, JSON.stringify({ ...policy, revision: 'revoked', grants: [] }), { mode: 0o600 }); await rename(replacement, f.path);
    await expect(gate.authorize('execute', request, principal)).rejects.toThrow('POLICY_DENIED');
    await rm(f.path); await expect(gate.authorize('execute', request, principal)).rejects.toThrow('POLICY_UNAVAILABLE');
    await expect(stat(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects unsafe permissions, wrong owner, hardlinks and symlink substitutions', async () => {
    const f = await fixture(); await chmod(f.path, 0o644); await expect(f.source.load()).rejects.toThrow('POLICY_FILE_UNSAFE');
    await chmod(f.path, 0o400); expect((await f.source.load()).revision).toBe('initial');
    await expect(new FilePolicySource({ path: f.path, ownerUid: process.getuid!() + 1, maxBytes: 4096 }).load()).rejects.toThrow('POLICY_FILE_UNSAFE');
    await link(f.path, join(f.root, 'linked')); await expect(f.source.load()).rejects.toThrow('POLICY_FILE_UNSAFE');
    await rm(join(f.root, 'linked')); await rename(f.path, join(f.root, 'real')); await symlink(join(f.root, 'real'), f.path);
    await expect(f.source.load()).rejects.toThrow('POLICY_FILE_UNSAFE');
  });
  it('bounds bytes, rejects invalid documents and honors relocated registered policy path', async () => {
    const f = await fixture(); await expect(new FilePolicySource({ path: f.path, ownerUid: process.getuid!(), maxBytes: 8 }).load()).rejects.toThrow('POLICY_FILE_TOO_LARGE');
    await writeFile(f.path, '{ private-invalid'); await expect(f.source.load()).rejects.toThrow('POLICY_FILE_INVALID');
    const data = join(f.root, 'data'); await mkdir(join(data, 'authority'), { recursive: true, mode: 0o700 });
    await writeFile(join(data, 'authority/rules.json'), JSON.stringify(policy), { mode: 0o600 });
    const layout = resolveProductLayout({ projectRoot: f.root, root: data, resources: { policy: 'authority/rules.json' } });
    const source = createLayoutPolicySource(layout, process.getuid!(), 4096); expect((await source.load()).revision).toBe('initial');
  });
});
