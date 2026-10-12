import { expect, it } from 'vitest';
import { parseModelInvocationReceipt, modelInvocationRequestEvidence, encodeModelInvocationRequest, encodeModelInvocationProfile,
  resolveModelBindingDefinition, encodeModelBindingDefinition, type RunProposal } from '#domain/index.js';
import { assertRunProposalSource } from '#engine/index.js';
import { sha256 } from '#platform/index.js';
import { brainOutputDigest } from '#capabilities/index.js';
import { proposalFixture } from '../support/run-proposal.js';
const reference = { providerId: 'test-provider', providerVersion: 1, modelId: 'test-model', modelVersion: 1 };
const definition = resolveModelBindingDefinition({ schemaVersion: 1, revision: 'catalog', providers: [{ id: reference.providerId, version: 1,
  models: [{ id: reference.modelId, version: 1, nativeId: 'test-native', protocols: [{ family: 'chat', version: '1', capabilities: [] }] }] }] }, reference)!;
const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const, digest: sha256(encodeModelBindingDefinition(definition)) };
const command = { schemaVersion: 1 as const, commandId: 'planning-command', scopeId: 's', reference, catalogRevision: 'catalog', expectedBinding: binding, nativeRequest: {} };
const profile = { schemaVersion: 1 as const, id: 'profile', version: 1, scopeId: 's', reference, bindingDigest: binding.digest,
  protocol: { family: 'chat', version: '1' }, adapter: { id: 'test-adapter', version: 1, definition: {} },
  allocation: { id: 'test-allocation', maxCalls: 1, maxInFlight: 1 }, limits: { requestMaxBytes: 1024, responseMaxBytes: 2048, timeoutMs: 1000 } };
const proposal = proposalFixture(), requestDigest = sha256(encodeModelInvocationRequest(command)), profileDigest = sha256(encodeModelInvocationProfile(profile));
const responseDigest = sha256('retained-test-model-response');
const receipt = parseModelInvocationReceipt({ schemaVersion: 4, request: modelInvocationRequestEvidence(command, requestDigest),
  actor: { ...proposal.proposer, assurance: 'os-user' }, authorization: { revision: 'policy', ruleId: 'rule' }, definition, activationRevision: 1, profile, profileDigest,
  claim: { scopeId: 's', commandId: command.commandId, invocationId: 'planning-invocation', requestDigest, profileDigest }, claimedAtMs: 1,
  outcome: { schemaVersion: 4, state: 'responded', content: { schemaVersion: 1, kind: 'native-response', encoding: 'canonical-json', digest: responseDigest, byteLength: 1 }, observedAtMs: 2 } });
const modelProposal: RunProposal = { ...proposal, source: { kind: 'model', receipt: { commandId: command.commandId,
  invocationId: receipt.claim.invocationId, reference, responseDigest } } };
it('model attribution consumes an existing response receipt, projecting the actor without treating assurance as identity', () => {
  expect(() => assertRunProposalSource(modelProposal, receipt)).not.toThrow();
  expect(() => assertRunProposalSource(proposal, null)).not.toThrow();
});
it.each(['missing', 'pending', 'actor', 'scope', 'command', 'invocation', 'digest', 'model'] as const)('refuses %s receipt substitution without a model call', kind => {
  const source = modelProposal.source;
  if (source.kind !== 'model') throw new Error('fixture');
  const changed = kind === 'actor' ? { ...receipt, actor: { ...receipt.actor, subject: 'foreign' } }
    : kind === 'scope' ? { ...receipt, request: { ...receipt.request, scopeId: 'foreign' } }
      : kind === 'pending' ? { ...receipt, outcome: null } : kind === 'missing' ? null : receipt;
  const refs = { ...source.receipt, ...(kind === 'command' ? { commandId: 'foreign' } : kind === 'invocation' ? { invocationId: 'foreign' }
    : kind === 'digest' ? { responseDigest: sha256('foreign') } : kind === 'model' ? { reference: { ...reference, modelVersion: 2 } } : {}) };
  expect(() => assertRunProposalSource({ ...modelProposal, source: { ...source, receipt: refs } }, changed)).toThrow(expect.objectContaining({ code: 'RUN_PROPOSAL_SOURCE_INVALID' }));
});
it('binds a Brain graph to the retained model output, invocation request, binding and activation before Run admission', () => {
  const draft = { graph: modelProposal.graph, budgetCeiling: modelProposal.budgetCeiling, requiredPermissions: modelProposal.requiredPermissions };
  if (modelProposal.source.kind !== 'model') throw new Error('fixture');
  const contribution = { schemaVersion: 1 as const, template: { id: 'fixture', version: 1, digest: sha256('template') },
    inputDigest: sha256('input'), contextDigest: sha256('context'), outputDigest: brainOutputDigest(draft), requestDigest,
    activationRevision: 1, bindingDigest: binding.digest, inputSummary: 'Plan a purchase', outputSummary: 'Readback', usage: null };
  const brain: RunProposal = { ...modelProposal, source: { ...modelProposal.source, contribution } }, text = JSON.stringify(draft);
  expect(() => assertRunProposalSource(brain, receipt, text)).not.toThrow();
  for (const altered of [{ ...brain, graph: { ...brain.graph, revision: 2 } },
    { ...brain, source: { ...brain.source, contribution: { ...contribution, requestDigest: sha256('foreign') } } },
    { ...brain, source: { ...brain.source, contribution: { ...contribution, activationRevision: 2 } } },
    { ...brain, source: { ...brain.source, contribution: { ...contribution, bindingDigest: sha256('foreign') } } }] as RunProposal[]) {
    expect(() => assertRunProposalSource(altered, receipt, text)).toThrow(expect.objectContaining({ code: 'RUN_PROPOSAL_SOURCE_INVALID' }));
  }
  expect(() => assertRunProposalSource(brain, receipt, null)).toThrow(expect.objectContaining({ code: 'RUN_PROPOSAL_SOURCE_INVALID' }));
});
