import { describe, expect, it } from 'vitest';
import { parseProviderSpendAuditCommand } from '#domain/index.js';
import { createProviderSpendAccount, createProviderSpendAuditReceipt, createProviderSpendCheckpoint,
  parseProviderSpendAuditReceipt } from '#engine/index.js';

const budget = { schemaVersion: 1 as const, scopeId: 'scope', budgetId: 'budget', revision: 3,
  currency: 'USD', limitMinorUnits: 100 };
const checkpoint = createProviderSpendCheckpoint({ ...createProviderSpendAccount(budget), reservedMinorUnits: 7,
  settledMinorUnits: 1, settledExactMinorUnits: '0.25' }, 4, 1);
const command = { schemaVersion: 1 as const, commandId: 'audit-one', scopeId: 'scope', budgetId: 'budget',
  budgetRevision: 3, expectedCheckpointDigest: checkpoint.digest };
const principal = { id: 'actor', issuer: 'issuer', subject: 'subject', assurance: 'token-verified' as const,
  scopeIds: ['scope'] };
const authorization = { revision: 'policy-1', ruleId: 'audit-rule' };

function receipt(overrides: Partial<Parameters<typeof createProviderSpendAuditReceipt>[0]> = {}) {
  return createProviderSpendAuditReceipt({ command, principal, authorization, examinedCheckpoint: checkpoint,
    startedAtMs: 10, completedAtMs: 20, ...overrides });
}

describe('provider spending audit receipt contract', () => {
  it('round-trips one immutable, correlated checkpoint without retaining principal scope grants', () => {
    const created = receipt(), parsed = parseProviderSpendAuditReceipt(JSON.parse(JSON.stringify(created)));
    expect(parsed).toEqual(created);
    expect(parsed.actor).toEqual({ id: 'actor', issuer: 'issuer', subject: 'subject', assurance: 'token-verified' });
    expect(parsed.actor).not.toHaveProperty('scopeIds');
    expect(Object.isFrozen(parsed)).toBe(true); expect(Object.isFrozen(parsed.command)).toBe(true);
    expect(Object.isFrozen(parsed.actor)).toBe(true); expect(Object.isFrozen(parsed.authorization)).toBe(true);
    expect(Object.isFrozen(parsed.examinedCheckpoint)).toBe(true);
  });

  it('copies mutable creator and parser inputs instead of retaining aliases', () => {
    const mutableCommand = { ...command }, mutablePrincipal = { ...principal, scopeIds: [...principal.scopeIds] };
    const created = receipt({ command: mutableCommand, principal: mutablePrincipal });
    mutableCommand.budgetId = 'changed'; mutablePrincipal.scopeIds[0] = 'changed';
    expect(created.command.budgetId).toBe('budget'); expect(created.actor.id).toBe('actor');
    const wire = JSON.parse(JSON.stringify(created));
    const parsed = parseProviderSpendAuditReceipt(wire); wire.actor.id = 'changed'; wire.examinedCheckpoint.account.budget.currency = 'EUR';
    expect(parsed.actor.id).toBe('actor'); expect(parsed.examinedCheckpoint.account.budget.currency).toBe('USD');
  });

  it('rejects receipt and nested tampering even when basic shapes remain valid', () => {
    const valid = receipt();
    for (const changed of [
      { ...valid, completedAtMs: 21 },
      { ...valid, actor: { ...valid.actor, subject: 'other' } },
      { ...valid, authorization: { ...valid.authorization, ruleId: 'other' } },
      { ...valid, examinedCheckpoint: { ...valid.examinedCheckpoint, digest: '0'.repeat(64) } },
      { ...valid, extra: true },
      { ...valid, actor: { ...valid.actor, extra: true } },
    ]) expect(() => parseProviderSpendAuditReceipt(changed)).toThrow('PROVIDER_SPEND_INVALID');
  });

  it('rejects foreign scope, budget, revision and expected checkpoint identities', () => {
    for (const changed of [{ scopeId: 'other' }, { budgetId: 'other' }, { budgetRevision: 4 },
      { expectedCheckpointDigest: '0'.repeat(64) }]) {
      expect(() => receipt({ command: { ...command, ...changed } as never })).toThrow('PROVIDER_SPEND_CONFLICT');
    }
    expect(() => receipt({ principal: { ...principal, scopeIds: ['other'] } })).toThrow('PROVIDER_SPEND_CONFLICT');
  });

  it('rejects malformed commands, invalid timestamps and strict extra fields', () => {
    for (const invalid of [{ ...command, schemaVersion: 2 }, { ...command, commandId: '' },
      { ...command, expectedCheckpointDigest: 'ABC' }, { ...command, extra: true }]) {
      expect(() => parseProviderSpendAuditCommand(invalid)).toThrow();
      expect(() => receipt({ command: invalid as never })).toThrow('PROVIDER_SPEND_INVALID');
    }
    for (const times of [{ startedAtMs: -1 }, { completedAtMs: -1 }, { startedAtMs: 21, completedAtMs: 20 },
      { completedAtMs: Number.MAX_SAFE_INTEGER + 1 }]) expect(() => receipt(times)).toThrow('PROVIDER_SPEND_INVALID');
    expect(() => receipt({ authorization: { ...authorization, extra: true } })).toThrow('PROVIDER_SPEND_INVALID');
  });

  it('allows distinct commands to audit the same immutable checkpoint', () => {
    const first = receipt(), second = receipt({ command: { ...command, commandId: 'audit-two' } });
    expect(first.examinedCheckpoint.digest).toBe(second.examinedCheckpoint.digest);
    expect(first.digest).not.toBe(second.digest);
  });
});
