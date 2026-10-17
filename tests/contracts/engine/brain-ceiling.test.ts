import { expect, it } from 'vitest';
import { BrainPlanApplication, modelInvocationRequestDigest, type BrainPlanPorts } from '#engine/index.js';
import type { RunProposal } from '#domain/index.js';
import { sha256 } from '#platform/index.js';
import { proposalFixture } from '../support/run-proposal.js';

// Owner 2026-10-17: the system, not the model, bounds the declared ceiling; the model's number can only narrow it.
const principal = { id: 'owner', issuer: 'test', subject: 'owner', assurance: 'os-user' as const, scopeIds: ['s'] };
const reference = { providerId: 'p', providerVersion: 1, modelId: 'm', modelVersion: 1 };
const invocation = { schemaVersion: 1 as const, commandId: 'x', scopeId: 's', reference, catalogRevision: 'c', expectedBinding: { encodingVersion: 1 as const, algorithm: 'sha256' as const, digest: 'b'.repeat(64) }, nativeRequest: {} };
async function plan(asked: number, left: Readonly<{ currency: string; remainingMinorUnits: number }> | null | undefined) {
  const { graph, requiredPermissions } = proposalFixture('business'), proposals: RunProposal[] = [];
  const ports: BrainPlanPorts = {
    inspect: async () => null,
    prepare: async () => ({ invocation, prompt: { template: { id: 't', version: 1, digest: 'd'.repeat(64) }, summaryChars: 64, inputDigest: 'i'.padEnd(64, '0'), contextDigest: 'c'.padEnd(64, '0'),
      intent: 'plan', messages: [], invocationSettings: {} } as never }),
    invoke: async command => ({ receipt: { request: { requestDigest: modelInvocationRequestDigest(command), commandId: command.commandId, reference, expectedBinding: command.expectedBinding, scopeId: 's' },
      actor: principal, claim: { invocationId: 'inv' }, activationRevision: 1, profile: { schemaVersion: 1, adapter: { definition: {} } },
      outcome: { state: 'responded', content: { digest: sha256('reply') } } } } as never),
    text: () => JSON.stringify({ graph, budgetCeiling: { currency: 'USD', limitMinorUnits: asked }, requiredPermissions }),
    stoppedAtLength: () => false,
    propose: async proposal => { proposals.push(proposal); return {} as never; },
    ...(left === undefined ? {} : { remainingBudget: async () => left }),
  };
  await new BrainPlanApplication({ verify: async () => principal }, ports).plan({ schemaVersion: 1, scopeId: 's', commandId: 'c', intent: 'plan a purchase' });
  return proposals[0]!.budgetCeiling;
}
it('narrows a ceiling above the money left to exactly the money left, and keeps a smaller one', async () => {
  expect(await plan(10_000, { currency: 'USD', remainingMinorUnits: 8_783 })).toEqual({ currency: 'USD', limitMinorUnits: 8_783 });
  expect(await plan(7, { currency: 'USD', remainingMinorUnits: 8_783 })).toEqual({ currency: 'USD', limitMinorUnits: 7 });
});
it('never turns an exhausted, negative, other-currency or unreadable budget into an admissible ceiling: the model number stays for validation to refuse', async () => {
  for (const left of [{ currency: 'USD', remainingMinorUnits: 0 }, { currency: 'USD', remainingMinorUnits: -5 }, { currency: 'EUR', remainingMinorUnits: 50 }, null, undefined])
    expect(await plan(10_000, left)).toEqual({ currency: 'USD', limitMinorUnits: 10_000 });
});
