import { hostname, tmpdir, userInfo } from 'node:os';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { configuredApproval } from '#composition/core/approvals/index.js';
import { openLocalIntegrityAuthority } from '#adapters/index.js';
import { openConfiguredAttemptStore } from '#composition/core/storage/index.js';
import { clearConfigCache, resolveProductLayout } from '#platform/index.js';

// C12 Q8: `authorizeApproval` (engine/core/approval/internal/application.ts:18) is one of the catalog-outside
// require-approval points (design note §1.6). Real composition surface: `configuredApproval` is the exact function
// CLI, MCP and the runtime-service socket call for approval inspect/decide/renew/list.
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(effect: 'allow' | 'deny' | 'require-approval') {
  const root = await mkdtemp(join(tmpdir(), 'deckent-approval-authz-')); roots.push(root);
  const project = join(root, 'project'); const data = join(root, 'data');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data } }));
  await mkdir(data, { recursive: true, mode: 0o700 });
  const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p', restrictions: [], grants: [
    // Scope membership (H34 S1) is a separate, pre-existing gate: it needs one trusted allow grant naming the scope,
    // on any resource, before the specific approval-action check below is ever reached.
    { id: 'scope-member', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals, resource: { kind: 'run', ids: 'all' } },
    { id: 'inspect-approvals', effect, actions: ['inspect'], scopes: ['s'], principals, resource: { kind: 'approval', ids: 'all' } },
  ] }), { mode: 0o600 });
  // First-start bootstrap in miniature: the ledger and the approval integrity key must exist before any `configuredApproval` call.
  await openLocalIntegrityAuthority(resolveProductLayout({ projectRoot: project, root: data }), 'authority.key', true);
  const options = { env: { HOME: join(root, 'home') } };
  const opened = await openConfiguredAttemptStore(project, options); opened.store.close();
  return { project, options };
}

it('returns a typed refusal, not denial, when approval inspection authority is require-approval (C12 Q8: no catalog broker here yet)', async () => {
  const f = await fixture('require-approval');
  await expect(configuredApproval(f.project, 'inspect', { schemaVersion: 1, scopeId: 's', approvalId: 'missing' }, f.options))
    .rejects.toMatchObject({ code: 'POLICY_APPROVAL_UNSUPPORTED' });
});
it('still denies plainly when there is no approval authority at all', async () => {
  const f = await fixture('deny');
  await expect(configuredApproval(f.project, 'inspect', { schemaVersion: 1, scopeId: 's', approvalId: 'missing' }, f.options))
    .rejects.toMatchObject({ code: 'APPROVAL_DENIED' });
});
it('still allows a granted inspection through to the (empty) store', async () => {
  const f = await fixture('allow');
  await expect(configuredApproval(f.project, 'inspect', { schemaVersion: 1, scopeId: 's', approvalId: 'missing' }, f.options))
    .resolves.toBeNull();
});
