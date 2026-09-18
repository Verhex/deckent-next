import { admitRunAttempts } from '../support/admission.js';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir, userInfo, hostname } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectConfiguredInventory } from '../../../src/composition/core/inventory/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { openSqliteAttemptStore } from '#adapters/index.js';
import { clearConfigCache } from '#platform/index.js';
import { custodyProfiles, dispatchAdmission } from '../support/custody.js';
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const query = { schemaVersion: 1, scopeId: 's', after: null, limit: 1 };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-inventory-composed-')); roots.push(root);
  const project = join(root, 'project'); const data = join(root, 'data'); await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  const config = { layout: { root: data, resources: { policy: 'access.json', ledger: 'state/custom.db' } }, inspection: { maxPageSize: 1, policyMaxBytes: 65536 } };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify(config));
  const options = { env: { HOME: join(root, 'home') } };
  async function policy(allow: boolean) {
    await mkdir(data, { recursive: true, mode: 0o700 });
    await writeFile(join(data, 'access.json'), JSON.stringify({ schemaVersion: 1, revision: allow ? 'allow' : 'deny', restrictions: [], grants: allow ? [
      { id: 'read', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals: [{ issuer: hostname(), subject: String(userInfo().uid) }], resource: { kind: 'scope', ids: ['s'] } },
    ] : [] }), { mode: 0o600 });
  }
  return { project, data, options, policy };
}
describe.skipIf(process.platform === 'win32')('configured local inventory query', () => {
  it('rejects budget/scope/missing policy before opening or creating the ledger', async () => {
    const f = await fixture();
    await expect(inspectConfiguredInventory(f.project, { ...query, limit: 2 }, f.options)).rejects.toMatchObject({ code: 'DISPATCH_INVENTORY_LIMIT' });
    await expect(inspectConfiguredInventory(f.project, { ...query, scopeId: 'other' }, f.options)).rejects.toMatchObject({ code: 'POLICY_UNAVAILABLE' });
    await expect(inspectConfiguredInventory(f.project, query, f.options)).rejects.toMatchObject({ code: 'POLICY_UNAVAILABLE' });
    await expect(stat(f.data)).rejects.toMatchObject({ code: 'ENOENT' });
    await f.policy(false); await expect(inspectConfiguredInventory(f.project, query, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(stat(join(f.data, 'state'))).rejects.toMatchObject({ code: 'ENOENT' });
    await f.policy(true); await expect(inspectConfiguredInventory(f.project, { ...query, scopeId: 'other' }, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(inspectConfiguredInventory(f.project, query, f.options)).rejects.toMatchObject({ code: 'MANAGED_FILE_MISSING' });
    await expect(stat(join(f.data, 'state'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects project-config scope injection without touching the data root', async () => {
    const f = await fixture(); const path = join(f.project, '.deckent/config.json');
    const config = JSON.parse(await readFile(path, 'utf8')); config.local_access = { scopeIds: ['s', 'other'] };
    await writeFile(path, JSON.stringify(config)); clearConfigCache();
    await expect(inspectConfiguredInventory(f.project, query, f.options)).rejects.toThrow();
    await expect(stat(f.data)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('reads the configured ledger and reflects subsequent policy revocation without stale authorization', async () => {
    const f = await fixture(); const opened = await openConfiguredAttemptStore(f.project, f.options); opened.store.close();
    const { path } = opened; const store = await openSqliteAttemptStore(path, { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' }, 'allow', custodyProfiles);
    const identity = { runId: 'r', taskId: 't', attemptId: 'a', scopeId: 's', layoutRevision: 'l', generation: 1 };
    try {
      await admitRunAttempts(store, [identity]);
      await store.claimDispatch(dispatchAdmission({ owner: 'worker', request: { protocolVersion: 1, identity, workspace: '/private', argv: ['secret'] } }));
    } finally { store.close(); }
    await f.policy(true); const before = await readFile(path);
    const result = await inspectConfiguredInventory(f.project, query, f.options);
    expect(result.schemaVersion).toBe(1); expect(result.layout.root).toBe(f.data); expect(result.page.entries[0]!).toMatchObject({ identity, launch: 'pending' });
    expect(JSON.stringify(result.page)).not.toContain('secret'); expect(await readFile(path)).toEqual(before);
    await f.policy(false); await expect(inspectConfiguredInventory(f.project, query, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });
});
