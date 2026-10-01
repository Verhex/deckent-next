import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePolicyBindings, separationOfDutiesViolation } from '#domain/index.js';
import { createHmacIntegrity } from '../../../src/platform/core/integrity/index.js';
import { openSqliteApprovalStore } from '../../../src/adapters/core/approval-store/index.js';
import { LocalOsSessionAuthority } from '../../../src/adapters/core/local-principal/index.js';
import { ApprovalApplication, requestTaskApproval } from '../../../src/engine/core/approval/index.js';
import { SQLITE_STORAGE_OPTIONS } from '../../../src/platform/core/config-fields/index.js';

// H34 S2 / C12 Q6: four-eyes is policy v2 data (`separationOfDuties`), enforced on the one approval decision path.
const approver = { id: 'approval', effect: 'allow', principals: 'all', scopes: ['scope'], actions: 'all', resource: { kind: 'approval', ids: 'all' } };
const v1 = { schemaVersion: 1, revision: 'policy', restrictions: [], grants: [approver] };
const v2 = (scopes: 'all' | string[] = 'all') => resolvePolicyBindings({ schemaVersion: 2, revision: 'policy', roles: [], restrictions: [], grants: [approver],
  separationOfDuties: [{ id: 'four-eyes', rule: 'requester-cannot-approve', scopes }] }, { schemaVersion: 1, revision: 'b', bindings: [] });

async function fixture(policy: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-four-eyes-'));
  const journal = openSqliteApprovalStore(join(root, 'ledger.db'), SQLITE_STORAGE_OPTIONS.parse({ busyTimeoutMs: 2000, journalMode: 'wal', durability: 'full' }), 'allow');
  const time = { sample: () => ({ wallMs: 1000, monotonicMs: 100 }) };
  const session = await LocalOsSessionAuthority.create(['scope'], 10000, time);
  const evidence = await session.verifySession(undefined);
  const integrity = createHmacIntegrity('key', randomBytes(32));
  const app = new ApprovalApplication(journal.store, { verify: async () => evidence.principal }, session, { load: async () => policy }, integrity, time, 'sdk', 20);
  const self = evidence.session.principalRef;
  const request = (requester: { id: string; issuer: string; subject: string }, digest: string) => requestTaskApproval(journal.store, integrity,
    { scopeId: 'scope', runId: 'run', taskId: 'task', requester, actionDigest: digest.repeat(64), policyRevision: 'policy', summary: 'Execute task', createdAt: 1000, expiresAt: 5000 });
  const command = (approvalId: string, commandId: string, decision: 'allow' | 'deny') =>
    ({ schemaVersion: 1, scopeId: 'scope', approvalId, commandId, expectedRevision: 0, decision, reason: 'four-eyes' });
  return { app, self, request, command, journal, close: async () => { journal.close(); await rm(root, { recursive: true, force: true }); } };
}

describe('separation of duties on the approval decision path', () => {
  it.skipIf(process.platform !== 'linux')('[requires Linux live OS session /proc identity] the requester cannot approve its own request (typed), leaves it pending and writes no receipt; another principal approves', async () => {
    const f = await fixture(v2());
    try {
      const own = f.request(f.self, 'a');
      await expect(f.app.decide(f.command(own.request.approvalId, 'self-allow', 'allow'))).rejects.toMatchObject({ code: 'APPROVAL_DENIED' });
      expect(f.journal.store.load('scope', own.request.approvalId)?.status).toBe('pending');
      expect(f.journal.store.receipt('scope', 'self-allow')).toBeNull();
      // Withdrawing one's own request grants nothing and stays possible.
      expect((await f.app.decide(f.command(own.request.approvalId, 'self-deny', 'deny'))).decision?.decision).toBe('deny');
      // Same subject under another issuer is another principal (exact identity, not a display id).
      const other = f.request({ id: 'colleague', issuer: `${f.self.issuer}-remote`, subject: f.self.subject }, 'b');
      const decided = await f.app.decide(f.command(other.request.approvalId, 'colleague-allow', 'allow'));
      expect(decided).toMatchObject({ status: 'decided', decision: { decision: 'allow', actor: { subject: f.self.subject, issuer: f.self.issuer } } });
    } finally { await f.close(); }
  });
  it.skipIf(process.platform !== 'linux')('[requires Linux live OS session /proc identity] is data: v1 policy and a rule scoped elsewhere keep self-approval (solo stays one step)', async () => {
    for (const policy of [v1, v2(['elsewhere'])]) {
      const f = await fixture(policy);
      try {
        const own = f.request(f.self, 'c');
        expect((await f.app.decide(f.command(own.request.approvalId, 'solo', 'allow'))).decision?.decision).toBe('allow');
      } finally { await f.close(); }
    }
  });
  it('the pure predicate names the violated rule and compares issuer and subject only', () => {
    const who = { id: 'a', issuer: 'host', subject: '1' };
    expect(separationOfDutiesViolation(v2(), { scopeId: 'scope', requester: who, decider: { ...who, id: 'renamed' } })).toBe('four-eyes');
    expect(separationOfDutiesViolation(v2(), { scopeId: 'scope', requester: who, decider: { ...who, subject: '2' } })).toBeNull();
    expect(separationOfDutiesViolation(v1, { scopeId: 'scope', requester: who, decider: who })).toBeNull();
  });
});
