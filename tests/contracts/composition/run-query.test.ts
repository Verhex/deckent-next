import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir, userInfo, hostname } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectRun } from '../../../src/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { clearConfigCache } from '#platform/index.js';
import { admitRunAttempts } from '../support/admission.js';
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const query = { schemaVersion: 1 as const, scopeId: 's', runId: 'r' };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-run-query-')); roots.push(root);
  const project = join(root, 'project'); const data = join(root, 'data'); await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data, resources: { policy: 'access.json', ledger: 'state/custom.db' } } }));
  const options = { env: { HOME: join(root, 'home') } };
  async function policy(ids: string[]) {
    await mkdir(data, { recursive: true, mode: 0o700 });
    await writeFile(join(data, 'access.json'), JSON.stringify({ schemaVersion: 1, revision: 'p', restrictions: [], grants: ids.length ? [
      { id: 'read', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals: [{ issuer: hostname(), subject: String(userInfo().uid) }], resource: { kind: 'run', ids } },
    ] : [] }), { mode: 0o600 });
  }
  return { project, data, options, policy };
}
describe.skipIf(process.platform === 'win32')('SDK configured Run inspection', () => {
  it('checks scope and specific Run policy before touching the ledger', async () => {
    const f = await fixture(); await f.policy(['other']);
    await expect(inspectRun(f.project, query, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(stat(join(f.data, 'state'))).rejects.toMatchObject({ code: 'ENOENT' });
    await f.policy(['r']); await expect(inspectRun(f.project, { ...query, scopeId: 'foreign' }, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(inspectRun(f.project, query, f.options)).rejects.toMatchObject({ code: 'MANAGED_FILE_MISSING' });
    await expect(stat(join(f.data, 'state'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('uses configured paths, reflects durable state and revocation without changing ledger contents', async () => {
    const f = await fixture(); const { store, path } = await openConfiguredAttemptStore(f.project, f.options);
    try { await admitRunAttempts(store, [{ runId: 'r', scopeId: 's', taskId: 't', attemptId: 'a', layoutRevision: 'l', generation: 1 }]); } finally { store.close(); }
    await f.policy(['r', 'missing']); const before = await readFile(path);
    const result = await inspectRun(f.project, query, f.options);
    expect(result.layout.root).toBe(f.data); expect(result.run!.runId).toBe('r'); expect(result.run!.tasks[0]!.phase).toBe('active');
    expect((await inspectRun(f.project, { ...query, runId: 'missing' }, f.options)).run).toBeNull(); expect(await readFile(path)).toEqual(before);
    await f.policy([]); await expect(inspectRun(f.project, query, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });
});
