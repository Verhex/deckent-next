import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encodeModelBindingDefinition, resolveModelBindingDefinition } from '#domain/core/provider-catalog/index.js';
import { createModelInvocationClaimReceipt, modelInvocationProfileDigest, modelInvocationRequestDigest,
  ModelInvocationCancellationApplication, type ModelInvocationCancellationAdmission,
  type ModelInvocationCancellationResult, type ModelInvocationCancellationStore } from '#engine/core/model-invocation/index.js';

const reference = { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 };
const definition = resolveModelBindingDefinition({ schemaVersion: 1, revision: 'catalog', providers: [{ id: 'provider', version: 1,
  models: [{ id: 'model', version: 1, nativeId: 'native', protocols: [{ family: 'chat', version: '1', capabilities: [] }] }] }] }, reference)!;
const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const,
  digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
const invocationCommand = { schemaVersion: 1 as const, commandId: 'invoke', scopeId: 'scope', reference,
  catalogRevision: 'catalog', expectedBinding: binding, nativeRequest: { prompt: 'private' } };
const profile = { schemaVersion: 1 as const, id: 'profile', version: 1, scopeId: 'scope', reference, bindingDigest: binding.digest,
  protocol: { family: 'chat', version: '1' }, adapter: { id: 'adapter', version: 1, definition: {} },
  allocation: { id: 'allocation', maxCalls: 2, maxInFlight: 1 }, limits: { requestMaxBytes: 1024, responseMaxBytes: 1024, timeoutMs: 1000 } };
const actor = { id: 'verified', issuer: 'os', subject: '1000', assurance: 'os-user' as const };
const invocationReceipt = createModelInvocationClaimReceipt({ command: invocationCommand,
  requestDigest: modelInvocationRequestDigest(invocationCommand), actor, authorization: { revision: 'invoke-policy', ruleId: 'invoke' },
  definition, activation: { schemaVersion: 1, scopeId: 'scope', reference, revision: 1, state: 'active',
    catalogRevision: 'catalog', definition, binding }, profile, profileDigest: modelInvocationProfileDigest(profile),
  invocationId: 'generated', claimedAtMs: 1 });
const command = { schemaVersion: 1 as const, commandId: 'cancel', scopeId: 'scope', targetCommandId: 'invoke', reference,
  expectedRequestDigest: invocationReceipt.claim.requestDigest };

interface Options {
  readonly replayed?: boolean; readonly denyAt?: number; readonly missing?: boolean; readonly loadError?: boolean;
  readonly writeError?: boolean; readonly substitute?: (result: ModelInvocationCancellationResult) => ModelInvocationCancellationResult;
}
function fixture(options: Options = {}) {
  let opens = 0, loads = 0, writes = 0, closes = 0, policies = 0;
  const admissions: ModelInvocationCancellationAdmission[] = [], targets: unknown[] = [];
  const historical = { schemaVersion: 1 as const, command, claim: invocationReceipt.claim, actor,
    authorization: { revision: 'historical', ruleId: 'cancel' }, requestedAtMs: 4, disposition: 'prevented' as const };
  const store: ModelInvocationCancellationStore = {
    async loadReceipt(scopeId, commandId) { loads++; if (options.loadError) throw new Error('LOAD');
      if (!options.missing) expect([scopeId, commandId]).toEqual(['scope', 'invoke']);
      return options.missing ? null : { receipt: invocationReceipt, content: null, purge: null }; },
    async loadControl() { return null; },
    async cancelInvocation(input) { writes++; admissions.push(input); if (options.writeError) throw new Error('WRITE');
      const result: ModelInvocationCancellationResult = options.replayed ? { replayed: true, receipt: historical }
        : { replayed: false, receipt: { schemaVersion: 1, ...input, claim: invocationReceipt.claim, disposition: 'prevented' } };
      return options.substitute?.(result) ?? result; },
    close() { closes++; },
  };
  const app = new ModelInvocationCancellationApplication({ async verify(credential) {
    expect(credential).toEqual({ id: 'client-supplied', actor: { id: 'forged' } });
    return { ...actor, scopeIds: ['scope'] };
  } }, { async authorize(action, target) { policies++; targets.push(target); expect(action).toBe('cancel-invocation');
    if (options.denyAt === policies) throw new Error(`DENIED_${policies}`);
    return { revision: `policy-${policies}`, ruleId: 'cancel' };
  } }, async () => { opens++; return store; }, { now: () => 10 });
  return { app, admissions, targets, counts: () => ({ opens, loads, writes, closes, policies }) };
}
const credential = { id: 'client-supplied', actor: { id: 'forged' } };

describe('model invocation cancellation application', () => {
  it('uses the verified actor, samples policy twice, and preserves the exact audit command', async () => {
    const f = fixture(), result = await f.app.cancel(command, credential);
    expect(result).toMatchObject({ replayed: false, receipt: { command, claim: invocationReceipt.claim, actor,
      authorization: { revision: 'policy-2' }, requestedAtMs: 10, disposition: 'prevented' } });
    expect(f.admissions).toEqual([{ command, actor, authorization: { revision: 'policy-2', ruleId: 'cancel' }, requestedAtMs: 10 }]);
    expect(f.targets).toEqual([command, command]);
    expect(f.counts()).toEqual({ opens: 1, loads: 1, writes: 1, closes: 1, policies: 2 });
  });

  it('reauthorizes replay and rejects policy changes before any cancellation write', async () => {
    const replay = fixture({ replayed: true });
    expect(await replay.app.cancel(command, credential)).toMatchObject({ replayed: true,
      receipt: { authorization: { revision: 'historical' }, requestedAtMs: 4 } });
    expect(replay.counts()).toEqual({ opens: 1, loads: 1, writes: 1, closes: 1, policies: 2 });
    for (const denyAt of [1, 2]) {
      const denied = fixture({ replayed: true, denyAt });
      await expect(denied.app.cancel(command, credential)).rejects.toThrow(`DENIED_${denyAt}`);
      expect(denied.counts()).toEqual(denyAt === 1
        ? { opens: 0, loads: 0, writes: 0, closes: 0, policies: 1 }
        : { opens: 1, loads: 1, writes: 0, closes: 1, policies: 2 });
    }
  });

  it('requires the exact stored target digest and reference before fresh policy or mutation', async () => {
    for (const changed of [{ ...command, expectedRequestDigest: '0'.repeat(64) },
      { ...command, reference: { ...reference, modelId: 'foreign' } }, { ...command, targetCommandId: 'foreign' }]) {
      const f = fixture({ missing: changed.targetCommandId === 'foreign' });
      await expect(f.app.cancel(changed, credential)).rejects.toMatchObject({ code: 'MODEL_INVOCATION_COMMAND_CONFLICT' });
      expect(f.counts()).toEqual({ opens: 1, loads: 1, writes: 0, closes: 1, policies: 1 });
    }
  });

  it('checks delivery capacity before mutation and always closes an opened store on failure', async () => {
    const bounded = fixture();
    await expect(bounded.app.cancel(command, credential, { maxResultBytes: 1 }))
      .rejects.toMatchObject({ code: 'MODEL_INVOCATION_RESULT_LIMIT' });
    expect(bounded.counts()).toEqual({ opens: 1, loads: 1, writes: 0, closes: 1, policies: 2 });
    for (const options of [{ loadError: true }, { writeError: true }]) {
      const failed = fixture(options); await expect(failed.app.cancel(command, credential)).rejects.toThrow();
      expect(failed.counts().closes).toBe(1);
    }
  });

  it('rejects substituted fresh and replayed receipts after the store write', async () => {
    const substitutions = [
      (result: ModelInvocationCancellationResult) => ({ ...result, receipt: { ...result.receipt,
        command: { ...result.receipt.command, commandId: 'foreign' } } }),
      (result: ModelInvocationCancellationResult) => ({ ...result, receipt: { ...result.receipt,
        actor: { ...result.receipt.actor, id: 'foreign' } } }),
      (result: ModelInvocationCancellationResult) => ({ ...result, receipt: { ...result.receipt,
        claim: { ...result.receipt.claim, invocationId: 'foreign' } } }),
    ];
    for (const replayed of [false, true]) for (const substitute of substitutions) {
      const f = fixture({ replayed, substitute });
      await expect(f.app.cancel(command, credential)).rejects.toMatchObject({ code: 'MODEL_INVOCATION_CORRUPT' });
      expect(f.counts()).toEqual({ opens: 1, loads: 1, writes: 1, closes: 1, policies: 2 });
    }
    for (const substitute of [
      (result: ModelInvocationCancellationResult) => ({ ...result, receipt: { ...result.receipt,
        authorization: { revision: 'foreign', ruleId: 'cancel' } } }),
      (result: ModelInvocationCancellationResult) => ({ ...result, receipt: { ...result.receipt, requestedAtMs: 11 } }),
    ]) {
      const f = fixture({ substitute });
      await expect(f.app.cancel(command, credential)).rejects.toMatchObject({ code: 'MODEL_INVOCATION_CORRUPT' });
    }
  });
});
