import type { RunProposal } from '#domain/index.js';
/** Business readback criterion; no Git-specific acceptance or model invocation. */
export function proposalFixture(workClass = 'small', proposer: RunProposal['proposer'] = { id: 'owner', issuer: 'test', subject: 'owner' }): RunProposal {
  return { schemaVersion: 1, commandId: 'propose', proposalId: 'proposal', scopeId: 's', runId: 'r', proposer, source: { kind: 'human' },
    budgetCeiling: { currency: 'USD', limitMinorUnits: 200 }, requiredPermissions: [], graph: { schemaVersion: 4, revision: 1,
      tasks: [{ id: 'task', kind: 'purchase', workClass, dependencies: [], acceptanceCriteria: ['readback'] }],
      criterionDefinitions: [{ id: 'readback', version: 1, description: 'Durable business evidence', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] } };
}
/** Worked admission default: 256 independent tasks at graph v5's 64-resource maximum. */
export function largeResourceProposalFixture(): RunProposal {
  const proposal = proposalFixture();
  return { ...proposal, graph: { ...proposal.graph, schemaVersion: 5,
    tasks: Array.from({ length: 256 }, (_, i) => ({ id: `t-${i}`, kind: 'work', dependencies: [], acceptanceCriteria: ['readback'],
      resources: Array.from({ length: 64 }, (_, j) => ({ kind: 'record', id: `record-${i}-${j}` })) })) } };
}
