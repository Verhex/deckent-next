import { describe, expect, it } from 'vitest';
import { encodeDeckentJson, type JsonValue, candidateBindingSchema, targetQueueRequestSchema, taskGraphSchema, type RunSnapshot } from '#domain/index.js';
import { assertQueueVerification, queueVerificationGraph, resolveExecutionRegistry, newQueueRecord, type AdoptionVerificationRequirement } from '#engine/index.js';
const identity = { scopeId: 's', runId: 'original', taskId: 'task', attemptId: 'a', generation: 1, layoutRevision: 'l' };
const definition = { id: 'original-criterion', version: 1, description: 'Business outcome retained', evaluator: { id: 'observed', version: 1 }, parameters: { resource: 'order-42', status: 'approved' } };
const registry = { schemaVersion: 1, revision: 'registry', profiles: [{ id: 'verification', version: 1, adapter: { id: 'business-adapter', version: 1 }, parameters: { mode: 'observe' } }],
  kinds: [{ kind: 'operation', profile: { id: 'verification', version: 1 } }, { kind: 'verification', profile: { id: 'verification', version: 1 } }],
  evaluators: [{ id: 'observed', version: 1, implementation: { id: 'readback', version: 1 } }] };
const validation = { profile() { return undefined; }, criterion() { return undefined; } };
const graph = taskGraphSchema.parse({ schemaVersion: 4, revision: 1, tasks: [{ id: 'task', kind: 'operation', dependencies: [], acceptanceCriteria: [definition.id] }], criterionDefinitions: [definition] });
const original = { graph, execution: resolveExecutionRegistry(graph, registry, validation), progress: [{ taskId: 'task', phase: 'accepted' }], bindings: [{ identity }] } as unknown as RunSnapshot;
const target = { schemaVersion: 1, installationId: 'i', adapter: { id: 'business-adapter', version: 1 }, resourceBinding: 'a'.repeat(64), target: { kind: 'record', id: 'order-42' } };
const record = newQueueRecord(targetQueueRequestSchema.parse({ schemaVersion: 1, commandId: 'queue', identity, target, actor: { id: 'human', issuer: 'os', subject: '1000' },
  payloadDigest: 'b'.repeat(64), policyRevision: 'p', outputDigest: 'c'.repeat(64), acceptedRevision: 7, submittedAt: 1, deadline: 1000 }), 1);
const bar: AdoptionVerificationRequirement = { required: true, kind: 'verification', criteria: [{ evaluator: { id: 'observed', version: 1 }, parameters: { resource: 'order-42', audit: true } }] };
function verified() {
  const expected = queueVerificationGraph(record, original, registry, bar);
  const candidate = candidateBindingSchema.parse({ schemaVersion: 1, target, identity, sourceBinding: 'd'.repeat(64), outputDigest: record.request.outputDigest, observedVersion: 'V1', effectiveVersion: 'V2', candidateVersion: 'V3',
    candidateDigest: 'e'.repeat(64), custodyReceipt: 'f'.repeat(64), criteria: expected.criteria, profileFingerprint: expected.profileFingerprint, replacesCommandId: null });
  const run = { graph: expected.graph, execution: resolveExecutionRegistry(expected.graph, registry, validation), progress: [{ taskId: 'task', phase: 'accepted' }] } as unknown as RunSnapshot;
  return { expected, candidate, run, custody: { baseRevision: 'V3', source: { sourceFingerprint: candidate.sourceBinding } } };
}
describe('combined candidate acceptance', () => {
  it('retains the original business evaluator and adds the current bar conjunctively', () => {
    const f = verified();
    expect(f.expected.graph.criterionDefinitions[0]).toEqual(definition);
    expect(f.expected.graph.tasks[0]?.kind).toBe('verification');
    expect(f.expected.graph.tasks[0]?.acceptanceCriteria).toEqual(['original-criterion', 'queue-bar-0']);
    expect(f.expected.graph.criterionDefinitions[1]?.parameters).toEqual(bar.criteria[0]!.parameters);
    expect(assertQueueVerification(f.candidate, f.expected, f.run, f.custody, bar, (_implementation, required, actual) => encodeDeckentJson(actual as JsonValue) === encodeDeckentJson(required as JsonValue))).toBe('accepted');
  });
  it('refuses a replaced evaluator implementation and an original Task that is no longer accepted', () => {
    expect(() => queueVerificationGraph(record, original, { ...registry, evaluators: [{ ...registry.evaluators[0], implementation: { id: 'readback', version: 2 } }] }, bar)).toThrow('ADOPTION_VERIFICATION_MISMATCH');
    expect(() => queueVerificationGraph(record, { ...original, progress: [{ ...original.progress[0]!, phase: 'failed' }] }, registry, bar)).toThrow('ADOPTION_NOT_ACCEPTED');
  });
  it.each(['source', 'version', 'graph', 'profile', 'criteria'] as const)('refuses an accepted Run with different %s evidence', mutation => {
    const f = verified(); let run = f.run, custody = f.custody;
    if (mutation === 'source') custody = { ...custody, source: { sourceFingerprint: '0'.repeat(64) } };
    if (mutation === 'version') custody = { ...custody, baseRevision: 'V4' };
    if (mutation === 'graph') run = { ...run, graph: { ...run.graph, revision: 2 } };
    if (mutation === 'profile') run = { ...run, execution: { ...run.execution, tasks: [{ ...run.execution.tasks[0]!, profile: { ...run.execution.tasks[0]!.profile, parameters: { mode: 'skip' } } }] } };
    if (mutation === 'criteria') run = { ...run, execution: { ...run.execution, criteria: run.execution.criteria.slice(1) } };
    expect(() => assertQueueVerification(f.candidate, f.expected, run, custody, bar, () => true)).toThrow('CANDIDATE_MISMATCH');
  });
});
