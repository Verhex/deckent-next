import { hostname, tmpdir, userInfo } from 'node:os';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openConfiguredAttemptStore } from '#composition/core/storage/index.js';
import { ensureConfiguredTerminalIdentity } from '#composition/core/scoped-request/index.js';
import { authorizeRuntimeEvents } from '#composition/core/runtime-service/index.js';
import { withLocalPrincipalChannel, type LocalPeerIdentity } from '#adapters/index.js';
import { clearConfigCache, productResourcePath } from '#platform/index.js';
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dk-events-auth-')); roots.push(root); await mkdir(join(root, '.deckent'));
  const env = { HOME: join(root, 'home'), DECKENT_GLOBAL_HOME: join(root, 'global') };
  await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'data') } }));
  const store = await openConfiguredAttemptStore(root, { env }); store.store.close();
  const policy = productResourcePath(store.layout, 'policy');
  const principal = { issuer: hostname(), subject: String(userInfo().uid) };
  const grants = [
    { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['scope'], principals: [principal], resource: { kind: 'scope', ids: ['scope'] } },
    { id: 'output', effect: 'allow', actions: ['read-output'], scopes: ['scope'], principals: [principal], resource: { kind: 'attempt', ids: 'all' } },
    { id: 'run', effect: 'allow', actions: ['inspect'], scopes: ['scope'], principals: [principal], resource: { kind: 'run', ids: ['visible'] } },
  ];
  const publish = async (entries = grants, revision = 'initial') => { await writeFile(policy, JSON.stringify({ schemaVersion: 1, revision, restrictions: [], grants: entries }), { mode: 0o600 }); clearConfigCache(); };
  await publish(); await ensureConfiguredTerminalIdentity(root, 'scope', { env });
  const peer: LocalPeerIdentity = { assurance: 'linux-so-peercred', pid: process.pid, uid: userInfo().uid, gid: userInfo().gid };
  const query = { schemaVersion: 1 as const, scopeId: 'scope', topics: ['run' as const], resume: null };
  return { root, env, query, peer, publish, grants };
}
it('uses the verified peer and scope membership, with no ambient-user fallback for a foreign peer', async () => {
  const f = await fixture(); const admit = await authorizeRuntimeEvents(f.root, f.query, f.peer, { env: f.env });
  expect(admit.principalKey).toContain(hostname());
  await expect(authorizeRuntimeEvents(f.root, f.query, { ...f.peer, uid: f.peer.uid + 1 }, { env: f.env })).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
  await expect(authorizeRuntimeEvents(f.root, { ...f.query, scopeId: 'foreign' }, f.peer, { env: f.env })).rejects.toHaveProperty('code');
});
it('rejects a denied requested topic before returning admission and retains exact record denials', async () => {
  const f = await fixture(); await expect(authorizeRuntimeEvents(f.root, { ...f.query, topics: ['run', 'approval'] }, f.peer, { env: f.env })).rejects.toMatchObject({ code: 'APPROVAL_DENIED' });
  const admit = await authorizeRuntimeEvents(f.root, f.query, f.peer, { env: f.env });
  const row = (id: string) => ({ record: { topic: 'run' as const, entity: 'run' as const, id, revision: 0, status: 'running' as const, observedAt: 1, evidence: 'ledger' as const, sourceLoss: false }, watermark: '0' });
  expect(await admit.allows(row('visible'))).toBe(true); expect(await admit.allows(row('hidden'))).toBe(false);
});
it('keeps the MCP channel as the distinct AI actor instead of applying owner observation grants', async () => {
  const f = await fixture();
  await expect(withLocalPrincipalChannel('mcp', () => authorizeRuntimeEvents(f.root, f.query, f.peer, { env: f.env }), f.peer)).rejects.toHaveProperty('code');
  const owner = await authorizeRuntimeEvents(f.root, f.query, f.peer, { env: f.env }); expect(owner.principalKey).not.toContain('/mcp');
});
it('binds policy and company/config changes into the view identity and fails closed on unreadable policy', async () => {
  const f = await fixture(), first = await authorizeRuntimeEvents(f.root, f.query, f.peer, { env: f.env });
  await f.publish(f.grants, 'second'); const second = await authorizeRuntimeEvents(f.root, f.query, f.peer, { env: f.env }); expect(second.binding).not.toBe(first.binding);
  await f.publish([], 'revoked'); await expect(authorizeRuntimeEvents(f.root, f.query, f.peer, { env: f.env })).rejects.toHaveProperty('code');
});
it('missing approval integrity material refuses admission without creating a key or changing business state', async () => {
  const f = await fixture();
  await f.publish([...f.grants, { id: 'approvals', effect: 'allow', actions: ['inspect'], scopes: ['scope'], principals: [{ issuer: hostname(), subject: String(userInfo().uid) }], resource: { kind: 'approval', ids: ['scope'] } }]);
  await expect(authorizeRuntimeEvents(f.root, { ...f.query, topics: ['approval'] }, f.peer, { env: f.env })).rejects.toMatchObject({ code: 'INTEGRITY_KEY_UNAVAILABLE' });
});
