import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encodeModelBindingDefinition, parseModelInvocationControlRecord, resolveModelBindingDefinition } from '#domain/index.js';
import { ModelInvocationCancellationRecoveryApplication, createModelInvocationClaimReceipt, modelInvocationProfileDigest, modelInvocationRequestDigest,
  type ModelInvocationCancellationInventory, type ModelInvocationCancellationInventoryEntry } from '#engine/core/model-invocation/index.js';

const reference = { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 };
const definition = resolveModelBindingDefinition({ schemaVersion: 1, revision: 'catalog', providers: [{ id: 'provider', version: 1,
  models: [{ id: 'model', version: 1, nativeId: 'native', protocols: [{ family: 'chat', version: '1', capabilities: [] }] }] }] }, reference)!;
const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const,
  digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
const profile = { schemaVersion: 1 as const, id: 'profile', version: 1, scopeId: 'scope', reference, bindingDigest: binding.digest,
  protocol: { family: 'chat', version: '1' }, adapter: { id: 'adapter', version: 1, definition: {} },
  allocation: { id: 'allocation', maxCalls: 4, maxInFlight: 4 }, limits: { requestMaxBytes: 1024, responseMaxBytes: 1024, timeoutMs: 1000 } };
const actor = { id: 'actor', issuer: 'os', subject: '1000', assurance: 'os-user' as const };
function entry(invocationId: string, send: 'permitted' | 'unobserved' = 'permitted'): ModelInvocationCancellationInventoryEntry {
  const command = { schemaVersion: 1 as const, commandId: `invoke-${invocationId}`, scopeId: 'scope', reference,
    catalogRevision: 'catalog', expectedBinding: binding, nativeRequest: { prompt: invocationId } };
  const receipt = createModelInvocationClaimReceipt({ command, requestDigest: modelInvocationRequestDigest(command), actor,
    authorization: { revision: 'invoke-policy', ruleId: 'invoke' }, definition,
    activation: { schemaVersion: 1, scopeId: 'scope', reference, revision: 1, state: 'active', catalogRevision: 'catalog', definition, binding },
    profile, profileDigest: modelInvocationProfileDigest(profile), invocationId, claimedAtMs: 1 });
  const cancellation = { schemaVersion: 1 as const,
    command: { schemaVersion: 1 as const, commandId: `cancel-${invocationId}`, scopeId: 'scope', targetCommandId: command.commandId,
      reference, expectedRequestDigest: receipt.claim.requestDigest }, claim: receipt.claim, actor,
    authorization: { revision: 'cancel-policy', ruleId: 'cancel' }, requestedAtMs: 2, disposition: 'requested' as const };
  const control = parseModelInvocationControlRecord({ schemaVersion: 1, claim: receipt.claim, reference,
    send: send === 'permitted' ? { state: 'permitted', ownerId: 'runtime', permittedAtMs: 1 } : { state: 'unobserved' }, cancellation });
  return { receipt, control };
}

function fixture(entries: readonly ModelInvocationCancellationInventoryEntry[], options: {
  readonly next?: string | null; readonly malformed?: unknown; readonly deny?: string; readonly fail?: string;
  readonly inspectError?: boolean; readonly closeError?: boolean;
} = {}) {
  let closes = 0, aborts = 0; const queries: unknown[] = [], policies: string[] = [];
  const inventory: ModelInvocationCancellationInventory = {
    async inspectCancellationInventory(query) { queries.push(query); if (options.inspectError) throw new Error('READ');
      return (options.malformed ?? { entries, nextAfterInvocationId: options.next === undefined
        ? entries.at(-1)?.receipt.claim.invocationId ?? null : options.next }) as never; },
    close() { closes++; if (options.closeError) throw new Error('CLOSE'); },
  };
  const app = new ModelInvocationCancellationRecoveryApplication({ async verify() {
    return { ...actor, scopeIds: ['scope'] };
  } }, { async authorize(_action, target) { policies.push(target.commandId);
    if (target.commandId === options.deny) throw Object.assign(new Error('DENIED'), { code: 'POLICY_DENIED' });
    if (target.commandId === options.fail) throw new Error('UNAVAILABLE');
    return { revision: 'fresh', ruleId: 'cancel' };
  } }, async () => inventory, { requestAbort() { aborts++; return 'abort-requested'; } }, { maxPageSize: 2 });
  return { app, counts: () => ({ closes, aborts, queries, policies }) };
}
const command = { schemaVersion: 1 as const, scopeId: 'scope', afterInvocationId: 'before' };

describe('model invocation cancellation recovery application', () => {
  it('validates the complete page before requesting any abort', async () => {
    const good = entry('first'), bad = { ...entry('second'), unexpected: true };
    const f = fixture([], { malformed: { entries: [good, bad], nextAfterInvocationId: 'second' } });
    await expect(f.app.recover(command)).rejects.toThrow();
    expect(f.counts()).toMatchObject({ aborts: 0, closes: 1, policies: [] });
    const original = entry('second'), forgedClaim = { ...original.receipt.claim, profileDigest: '0'.repeat(64) };
    const forged = { receipt: { ...original.receipt, profileDigest: '0'.repeat(64), claim: forgedClaim },
      control: { ...original.control, claim: forgedClaim, cancellation: { ...original.control.cancellation!, claim: forgedClaim } } };
    const semantic = fixture([], { malformed: { entries: [good, forged], nextAfterInvocationId: 'second' } });
    await expect(semantic.app.recover(command)).rejects.toThrow();
    expect(semantic.counts()).toMatchObject({ aborts: 0, closes: 1, policies: [] });
  });

  it('uses exact scope, cursor and SQL-bounded limit and rejects ordering or cursor substitution', async () => {
    const f = fixture([entry('first'), entry('second')]);
    await expect(f.app.recover(command)).resolves.toMatchObject({ nextAfterInvocationId: 'second' });
    expect(f.counts().queries).toEqual([{ ...command, limit: 2 }]);
    for (const malformed of [
      { entries: [entry('second'), entry('first')], nextAfterInvocationId: 'first' },
      { entries: [entry('first')], nextAfterInvocationId: 'foreign' },
      { entries: [{ ...entry('first'), receipt: { ...entry('first').receipt,
        claim: { ...entry('first').receipt.claim, scopeId: 'foreign' } } }], nextAfterInvocationId: 'first' },
    ]) {
      const bad = fixture([], { malformed }); await expect(bad.app.recover(command)).rejects.toThrow();
      expect(bad.counts().aborts).toBe(0);
    }
  });

  it('reauthorizes every entry and continues after policy denial and failure', async () => {
    const f = fixture([entry('first'), entry('second')], { deny: 'cancel-first', fail: 'cancel-second' });
    await expect(f.app.recover(command)).resolves.toEqual({ nextAfterInvocationId: 'second', outcomes: [
      { invocationId: 'first', status: 'denied' }, { invocationId: 'second', status: 'failed' },
    ] });
    expect(f.counts()).toMatchObject({ aborts: 0, closes: 1, policies: ['cancel-first', 'cancel-second'] });
  });

  it('reports unobserved custody as not-live without touching a controller or inventing terminal state', async () => {
    const f = fixture([entry('first', 'unobserved')]);
    await expect(f.app.recover(command)).resolves.toEqual({ nextAfterInvocationId: 'first',
      outcomes: [{ invocationId: 'first', status: 'not-live' }] });
    expect(f.counts()).toMatchObject({ aborts: 0, closes: 1 });
  });

  it('closes inventory after read, validation, and close failures and validates constructor bounds', async () => {
    const failed = fixture([], { inspectError: true }); await expect(failed.app.recover(command)).rejects.toThrow('READ');
    expect(failed.counts().closes).toBe(1);
    const close = fixture([], { closeError: true }); await expect(close.app.recover(command)).rejects.toThrow('CLOSE');
    expect(close.counts().closes).toBe(1);
    for (const maxPageSize of [0, 2_147_483_647, 1.5]) expect(() => new ModelInvocationCancellationRecoveryApplication(
      { async verify() { return { ...actor, scopeIds: ['scope'] }; } }, { async authorize() { return { revision: 'p', ruleId: 'r' }; } },
      async () => ({ async inspectCancellationInventory() { return { entries: [], nextAfterInvocationId: null }; }, close() {} }),
      { requestAbort() { return 'not-live'; } }, { maxPageSize })).toThrow();
  });
});
