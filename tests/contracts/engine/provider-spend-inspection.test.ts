import { describe, expect, it } from 'vitest';
import { createProviderSpendAccount, createProviderSpendAuditReceipt, createProviderSpendCheckpoint, ProviderSpendAccountInspectionApplication,
  parseProviderSpendAccountInspectionForQuery, type ProviderSpendAccountReader } from '#engine/index.js';

const principal = { id: 'actor', issuer: 'issuer', subject: 'subject', assurance: 'token-verified', scopeIds: ['scope'] };
const query = { schemaVersion: 1 as const, scopeId: 'scope', budgetId: 'budget', budgetRevision: 3 };
const budget = { schemaVersion: 1 as const, scopeId: 'scope', budgetId: 'budget', revision: 3,
  currency: 'USD', limitMinorUnits: 100 };
const checkpoint = createProviderSpendCheckpoint({ ...createProviderSpendAccount(budget), reservedMinorUnits: 7,
  settledMinorUnits: 1, settledExactMinorUnits: '0.5' }, 4, 1);
const actor = { ...principal };
function audit(examinedCheckpoint = checkpoint) {
  return createProviderSpendAuditReceipt({ command: { ...query, commandId: 'audit',
    expectedCheckpointDigest: examinedCheckpoint.digest }, principal: actor,
  authorization: { revision: 'policy', ruleId: 'audit' }, examinedCheckpoint, startedAtMs: 1, completedAtMs: 2 });
}

function fixture(snapshot: unknown = { checkpoint, audit: null }) {
  const calls = { opens: 0, loads: 0, closes: 0, authorizations: 0 };
  const openReader = async (): Promise<ProviderSpendAccountReader> => {
    calls.opens++;
    return { async loadSnapshot(observed) { calls.loads++; expect(observed).toEqual(query); return snapshot as never; },
      close() { calls.closes++; } };
  };
  const authorization = { async authorize(action: 'inspect', target: typeof query, observed: typeof principal) {
    calls.authorizations++; expect(action).toBe('inspect'); expect(target).toEqual({ scopeId: 'scope', budgetId: 'budget', budgetRevision: 3 });
    expect(observed).toEqual(principal);
  } };
  return { calls, authorization, openReader,
    app: new ProviderSpendAccountInspectionApplication({ async verify() { return principal; } }, authorization, openReader) };
}

describe('provider spending account inspection', () => {
  it('authenticates and authorizes the budget resource before opening storage', async () => {
    const deniedVerification = fixture();
    const verificationApp = new ProviderSpendAccountInspectionApplication({ async verify() { throw new Error('secret'); } },
      deniedVerification.authorization, deniedVerification.openReader);
    await expect(verificationApp.inspect(query, 'credential')).rejects.toThrow('AUTHENTICATION_REQUIRED');
    expect(deniedVerification.calls).toMatchObject({ opens: 0, loads: 0, authorizations: 0 });

    const deniedPolicy = fixture();
    const policyApp = new ProviderSpendAccountInspectionApplication({ async verify() { return principal; } },
      { async authorize() { deniedPolicy.calls.authorizations++; throw Object.assign(new Error('POLICY_DENIED'), { code: 'POLICY_DENIED' }); } },
      deniedPolicy.openReader);
    await expect(policyApp.inspect(query)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(deniedPolicy.calls).toMatchObject({ opens: 0, loads: 0, authorizations: 1 });
  });

  it('returns an immutable exact aggregate snapshot without inventing held detail', async () => {
    const f = fixture(), result = await f.app.inspect(query);
    expect(result).toEqual({ ...query, schemaVersion: 2, checkpoint, audit: null, spendingHistoryIntegrity: 'not-recorded' });
    expect(result.checkpoint?.account).toMatchObject({ reservedMinorUnits: 7, settledMinorUnits: 1,
      settledExactMinorUnits: '0.5', frozen: false, budget: { currency: 'USD' } });
    expect(result.checkpoint?.account).not.toHaveProperty('heldMinorUnits');
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.checkpoint)).toBe(true);
    expect(Object.isFrozen(result.checkpoint?.account)).toBe(true); expect(Object.isFrozen(result.checkpoint?.account.budget)).toBe(true);
    expect(f.calls).toMatchObject({ opens: 1, loads: 1, closes: 1, authorizations: 1 });
  });

  it('returns an explicit null checkpoint without fabricating a balance or currency', async () => {
    const result = await fixture({ checkpoint: null, audit: null }).app.inspect(query);
    expect(result).toEqual({ ...query, schemaVersion: 2, checkpoint: null, audit: null, spendingHistoryIntegrity: 'not-recorded' });
    expect(result).not.toHaveProperty('currency'); expect(result).not.toHaveProperty('account');
  });

  it('rejects cross-scope, wrong-budget and stale-revision checkpoints as typed conflicts', async () => {
    for (const changed of [{ scopeId: 'other' }, { budgetId: 'other' }, { revision: 4 }]) {
      const changedBudget = { ...budget, ...changed };
      await expect(fixture({ checkpoint: createProviderSpendCheckpoint(createProviderSpendAccount(changedBudget), 1, 0), audit: null }).app.inspect(query))
        .rejects.toMatchObject({ code: 'PROVIDER_SPEND_CONFLICT' });
    }
  });

  it('rejects malformed strict queries before authentication or storage', async () => {
    for (const malformed of [{ ...query, extra: true }, { ...query, schemaVersion: 2 }, { ...query, scopeId: '' },
      { ...query, budgetRevision: 0 }, null]) {
      const f = fixture();
      await expect(f.app.inspect(malformed)).rejects.toMatchObject({ code: 'PROVIDER_SPEND_INVALID' });
      expect(f.calls).toMatchObject({ opens: 0, loads: 0, authorizations: 0 });
    }
  });

  it('rejects corrupt checkpoints and mismatched result envelopes with typed errors', async () => {
    await expect(fixture({ checkpoint: { ...checkpoint, digest: '0'.repeat(64) }, audit: null }).app.inspect(query))
      .rejects.toMatchObject({ code: 'PROVIDER_SPEND_INVALID' });
    expect(() => parseProviderSpendAccountInspectionForQuery(query,
      { ...query, schemaVersion: 2, budgetId: 'other', checkpoint: null, audit: null, spendingHistoryIntegrity: 'not-recorded' }))
      .toThrow('PROVIDER_SPEND_CONFLICT');
    expect(() => parseProviderSpendAccountInspectionForQuery(query,
      { ...query, schemaVersion: 2, checkpoint: null, audit: null, spendingHistoryIntegrity: 'verified' })).toThrow('PROVIDER_SPEND_INVALID');
  });

  it('derives consistent and stale only from the latest exact audit checkpoint digest', async () => {
    const consistentAudit = audit(), consistent = await fixture({ checkpoint, audit: consistentAudit }).app.inspect(query);
    expect(consistent).toMatchObject({ schemaVersion: 2, audit: consistentAudit, spendingHistoryIntegrity: 'consistent' });
    const oldCheckpoint = createProviderSpendCheckpoint(checkpoint.account, 3, 1), staleAudit = audit(oldCheckpoint);
    const stale = await fixture({ checkpoint, audit: staleAudit }).app.inspect(query);
    expect(stale).toMatchObject({ audit: staleAudit, spendingHistoryIntegrity: 'stale' });
  });

  it('rejects wrong audit identity, corruption, and impossible derived status combinations', () => {
    const validAudit = audit(), base = { ...query, schemaVersion: 2 as const, checkpoint, audit: validAudit };
    expect(() => parseProviderSpendAccountInspectionForQuery(query,
      { ...base, spendingHistoryIntegrity: 'stale' })).toThrow('PROVIDER_SPEND_INVALID');
    expect(() => parseProviderSpendAccountInspectionForQuery(query,
      { ...base, audit: null, spendingHistoryIntegrity: 'consistent' })).toThrow('PROVIDER_SPEND_INVALID');
    expect(() => parseProviderSpendAccountInspectionForQuery(query,
      { ...base, checkpoint: null, spendingHistoryIntegrity: 'consistent' })).toThrow('PROVIDER_SPEND_INVALID');
    expect(() => parseProviderSpendAccountInspectionForQuery(query,
      { ...base, audit: { ...validAudit, digest: '0'.repeat(64) }, spendingHistoryIntegrity: 'consistent' }))
      .toThrow('PROVIDER_SPEND_INVALID');
    for (const changed of [{ budgetId: 'other' }, { scopeId: 'other' }]) {
      const foreignBudget = { ...budget, ...changed }, foreignCheckpoint = createProviderSpendCheckpoint(
        createProviderSpendAccount(foreignBudget), 1, 0);
      const foreignPrincipal = { ...principal, scopeIds: [foreignBudget.scopeId] };
      const foreign = createProviderSpendAuditReceipt({ command: { schemaVersion: 1, commandId: 'foreign',
        scopeId: foreignBudget.scopeId, budgetId: foreignBudget.budgetId, budgetRevision: foreignBudget.revision,
        expectedCheckpointDigest: foreignCheckpoint.digest }, principal: foreignPrincipal,
      authorization: { revision: 'policy', ruleId: 'audit' }, examinedCheckpoint: foreignCheckpoint,
      startedAtMs: 1, completedAtMs: 2 });
      expect(() => parseProviderSpendAccountInspectionForQuery(query,
        { ...base, audit: foreign, spendingHistoryIntegrity: 'stale' })).toThrow('PROVIDER_SPEND_CONFLICT');
    }
  });

  it('redacts backend failures, closes an opened reader, and preserves typed storage failures', async () => {
    const failedOpen = new ProviderSpendAccountInspectionApplication({ async verify() { return principal; } },
      { async authorize() {} }, async () => { throw new Error('database path'); });
    await expect(failedOpen.inspect(query)).rejects.toMatchObject({ code: 'PROVIDER_SPEND_UNAVAILABLE', message: 'PROVIDER_SPEND_UNAVAILABLE' });
    const f = fixture();
    const failedRead = new ProviderSpendAccountInspectionApplication({ async verify() { return principal; } }, f.authorization,
      async () => ({ async loadSnapshot() { throw new Error('raw sqlite detail'); }, close() { f.calls.closes++; } }));
    await expect(failedRead.inspect(query)).rejects.toMatchObject({ code: 'PROVIDER_SPEND_UNAVAILABLE', message: 'PROVIDER_SPEND_UNAVAILABLE' });
    expect(f.calls.closes).toBe(1);
  });
});
