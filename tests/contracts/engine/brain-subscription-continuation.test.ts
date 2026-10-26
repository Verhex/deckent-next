import { expect, it } from 'vitest';
import { BrainPlanApplication, modelInvocationRequestDigest, type BrainPlanPorts } from '#engine/index.js';
import type { ModelInvocationCommand, RunProposal } from '#domain/index.js';
import { sha256 } from '#platform/index.js';
import { proposalFixture } from '../support/run-proposal.js';

it('keeps the trusted continuation command identity and attributes the proposal to the paid receipt', async () => {
  const principal = { id: 'owner', issuer: 'test', subject: 'owner', assurance: 'os-user' as const, scopeIds: ['s'] };
  const reference = { providerId: 'p', providerVersion: 1, modelId: 'plan', modelVersion: 1 };
  const paid = { ...reference, modelId: 'chosen-api' };
  const invocation: ModelInvocationCommand = { schemaVersion: 1, commandId: 'first', scopeId: 's', reference, catalogRevision: 'catalog',
    expectedBinding: { encodingVersion: 1, algorithm: 'sha256', digest: 'b'.repeat(64) }, nativeRequest: {} };
  const next = { ...invocation, commandId: 'paid-continuation', reference: paid }, capability = new WeakSet([next]);
  const { graph, requiredPermissions, budgetCeiling } = proposalFixture('business');
  let calls = 0, proposed: RunProposal | undefined;
  const seen: string[] = [];
  const ports: BrainPlanPorts = {
    inspect: async () => null,
    prepare: async () => ({ invocation, prompt: { template: { id: 't', version: 1, digest: 'd'.repeat(64) }, summaryChars: 64,
      inputDigest: 'i'.padEnd(64, '0'), contextDigest: 'c'.padEnd(64, '0'), intent: 'plan', messages: [], invocationSettings: {} } as never }),
    continueBilling: async (_command, _result, notice) => { notice(paid); return next; },
    invoke: async command => {
      calls++;
      if (calls === 2) expect(capability.has(command)).toBe(true);
      return { receipt: { request: { requestDigest: modelInvocationRequestDigest(command), commandId: command.commandId,
        reference: command.reference, expectedBinding: command.expectedBinding, scopeId: 's' }, actor: principal,
        claim: { invocationId: `inv-${calls}` }, activationRevision: 1,
        profile: { schemaVersion: 2, billingAxis: calls === 1 ? 'subscription' : 'metered', adapter: { definition: {} } },
        outcome: calls === 1 ? { state: 'rejected', evidence: {} } : { state: 'responded', content: { digest: sha256('reply') } } } } as never;
    },
    text: () => JSON.stringify({ graph, budgetCeiling, requiredPermissions }), stoppedAtLength: () => false,
    propose: async proposal => { proposed = proposal; return {} as never; },
  };
  await new BrainPlanApplication({ verify: async () => principal }, ports).plan({ schemaVersion: 1, scopeId: 's', commandId: 'plan', intent: 'plan a purchase' },
    undefined, undefined, progress => { seen.push(progress.kind); });
  expect(calls).toBe(2); expect(seen).toEqual(['billing-switch']);
  expect(proposed?.source).toMatchObject({ kind: 'model', receipt: { commandId: next.commandId, invocationId: 'inv-2', reference: paid }, contribution: { billingAxis: 'metered' } });
});
