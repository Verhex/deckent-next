import { describe, expect, it, vi } from 'vitest';
import { encodeDeckentJson, sameAttemptIdentity, type JsonValue, candidateBindingSchema, targetQueueRequestSchema, taskGraphSchema, type RunSnapshot } from '#domain/index.js';
import { assertQueueVerification, queueVerificationGraph, resolveExecutionRegistry, newQueueRecord, createWorkspaceQueuePreparation, WorkspaceIntegrationApplication, WorkspacePatchApplication, workspacePatchSchema, patchDigest, patchExclusions, type AdoptionVerificationRequirement, type WorkspacePatch } from '#engine/index.js';
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
const file = (text: string) => ({ mode: '100644' as const, text, digest: patchDigest(text) });
const patch: WorkspacePatch = { schemaVersion: 1, kind: 'workspace-patch', identity, source: { schemaVersion: 1, adapter: { id: 'git', version: 1 }, sourceFingerprint: 'f'.repeat(64) },
  baseCommit: 'b'.repeat(40), snapshotDigest: 'd'.repeat(64), exclusions: { ...patchExclusions, excludedSegments: [...patchExclusions.excludedSegments], excludedPrefixes: [...patchExclusions.excludedPrefixes] },
  changes: [{ path: 'notes/in.txt', before: null, after: file('in\n') }] };
const principal = { id: 'p', issuer: 'i', subject: 'u', assurance: 'os-user' as const, scopeIds: ['s'] };
async function attempt(diverge = false, revokeAtClaim = false) {
  const bytes = new Map<string, Uint8Array>();
  let bound: { schemaVersion: 1; scopeId: string; digest: string; byteLength: number } | undefined, boundIdentity = identity;
  const artifacts = { async put(scopeId: string, value: Uint8Array) { const digest = patchDigest(value); bytes.set(digest, value); return { schemaVersion: 1 as const, scopeId, digest, byteLength: value.length }; },
    async read(_scope: string, receipt: { digest: string }) { return bytes.get(receipt.digest)!; } };
  const dispatch = { async loadBoundDispatch() { return { request: { identity: boundIdentity }, owner: 'o', terminal: { handle: 'h' }, ...(bound ? { patch: bound } : {}) }; },
    async loadBoundTask() { return { id: 'task', kind: 'operation', dependencies: [], acceptanceCriteria: ['original-criterion'] }; },
    async loadRun() { return original; }, async retainDispatchPatch(_claim: unknown, receipt: typeof bound) { bound = receipt; return { request: { identity }, owner: 'o', terminal: { handle: 'h' }, patch: receipt }; } };
  let revoked = false, prepares = 0, observes = 0, reads = 0;
  const verifier = { async verify(credential: unknown) { return credential === undefined || credential === 'valid' ? principal : null; } };
  const authorization = { async authorizeIdentity(operation: string, requested: typeof identity, actor: typeof principal) {
    if (actor.id !== principal.id || !sameAttemptIdentity(requested, identity) || (operation === 'read-output' && revoked)) {
      throw Object.assign(new Error('POLICY_DENIED'), { code: 'POLICY_DENIED' });
    }
    if (operation === 'read-output') reads++;
  } };
  const patches = new WorkspacePatchApplication(dispatch as never, artifacts, verifier, authorization, 65536, 'warn');
  await patches.prepare(identity, { async capture() { return patch; } }, dispatch as never);
  let planned: WorkspacePatch | undefined, finished = 0;
  const target = { async observe() { observes++; return { digest: (diverge && observes >= 3 ? 'f' : 'e').repeat(64), source: 'git', head: 'b'.repeat(40) }; },
    async prepare(intent: Parameters<import('#engine/index.js').IntegrationTarget['prepare']>[0]) {
      prepares++;
      return { schemaVersion: 1 as const, kind: 'integration-candidate' as const, command: intent.command, patch: intent.patch, observation: intent.observation,
        workspace: 'candidate', snapshotDigest: 'a'.repeat(64), application: 'candidate-only' as const };
    }, async verify() {} };
  const integrations = new WorkspaceIntegrationApplication(patches, target, verifier, authorization, artifacts, 65536);
  const preparation = createWorkspaceQueuePreparation({ bounds: { revalidations: 0 }, registry, bar, maxBytes: 65536, principal, artifacts, authorization, queue: { load: () => null } as never, async validate() {} },
    { async claimIntegration(intent) { if (revokeAtClaim) revoked = true; return { acquired: true, record: { intent, manifest: null } }; }, async finishIntegration() { finished++; },
      async loadRun() { return original; }, async loadRunWorkspaceCustody() { return null; } }, patches, {
      async target() { return target; },
      delivery: { async plan(_command, manifest, seen) { planned = seen; return { schemaVersion: 1 as const, baseCommit: seen.baseCommit, commit: 'c'.repeat(40), ref: `refs/deckent/deliveries/${'a'.repeat(64)}`, snapshotDigest: manifest.snapshotDigest }; } },
      async provider() { throw new Error('unused'); }, async withAdmission() { throw new Error('unused'); } });
  return { run: () => preparation.prepare(record, null), patches, integrations, revoke() { revoked = true; }, breakBinding() { boundIdentity = { ...identity, attemptId: 'foreign' }; },
    corruptBytes() { bytes.set(bound!.digest, Buffer.from('invalid JSON')); },
    planned: () => planned, finished: () => finished, prepares: () => prepares, observes: () => observes, reads: () => reads };
}

describe('combined candidate acceptance', () => {
  it('retains the original business evaluator and adds the current bar conjunctively', async () => {
    const f = verified();
    expect(f.expected.graph.criterionDefinitions[0]).toEqual(definition);
    expect(f.expected.graph.tasks[0]?.kind).toBe('verification');
    expect(f.expected.graph.tasks[0]?.acceptanceCriteria).toEqual(['original-criterion', 'queue-bar-0']);
    expect(f.expected.graph.criterionDefinitions[1]?.parameters).toEqual(bar.criteria[0]!.parameters);
    expect(assertQueueVerification(f.candidate, f.expected, f.run, f.custody, bar, (_implementation, required, actual) => encodeDeckentJson(actual as JsonValue) === encodeDeckentJson(required as JsonValue))).toBe('accepted');
    // Astra R1: a caller-supplied preview cannot replace this call's identity, grant or dispatch binding checks.
    const guarded = await attempt(), preview = await guarded.patches.preview(identity);
    const carriedCheck = (requested: typeof identity, credential?: unknown, reuse: unknown = preview) => Reflect.apply(guarded.integrations.check, guarded.integrations, [requested, credential, reuse]);
    await expect(carriedCheck({ ...identity, scopeId: 'foreign' }, 'invalid')).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
    await expect(carriedCheck({ ...identity, scopeId: 'foreign' }, 'valid')).rejects.toMatchObject({ code: 'AUTHENTICATION_SCOPE_DENIED' });
    await expect(carriedCheck({ ...identity, attemptId: 'foreign' }, 'valid')).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(carriedCheck({ ...identity, scopeId: 'foreign' }, 'invalid', true)).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
    await expect(carriedCheck({ ...identity, scopeId: 'foreign' }, 'valid', true)).rejects.toMatchObject({ code: 'AUTHENTICATION_SCOPE_DENIED' });
    guarded.breakBinding();
    await expect(carriedCheck(identity, 'valid')).rejects.toMatchObject({ code: 'PATCH_UNAVAILABLE' });
    guarded.revoke();
    await expect(carriedCheck(identity, 'valid')).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(carriedCheck(identity, 'valid', true)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(guarded.observes()).toBe(0);
    expect(guarded.prepares()).toBe(0);

    const mutable = await attempt(), held = await mutable.patches.preview(identity);
    try { held.patch.changes.push({ path: 'zz.txt', before: null, after: file('injected') }); } catch (error) { expect(error).toBeInstanceOf(TypeError); }
    expect((await mutable.patches.preview(identity, undefined, true)).patch).toEqual(patch);
    mutable.corruptBytes();
    await expect(mutable.patches.preview(identity, undefined, true)).rejects.toMatchObject({ code: 'PATCH_CORRUPT' });

    const stable = await attempt();
    const decode = vi.spyOn(workspacePatchSchema, 'safeParse');
    try {
      await expect(stable.run()).resolves.toMatchObject({ identity, observedVersion: 'b'.repeat(40) });
      expect(decode).toHaveBeenCalledTimes(2);
      expect(stable.reads()).toBe(8); // Retain plus every original preview admission.
      expect(stable.planned()).toEqual(patch);
      expect(stable.prepares()).toBe(1);
    } finally { decode.mockRestore(); }
    const moved = await attempt(true);
    await expect(moved.run()).rejects.toMatchObject({ code: 'PATCH_CONFLICT' });
    expect(moved.finished()).toBe(0);
  });
  it('refuses a replaced evaluator implementation and an original Task that is no longer accepted', async () => {
    expect(() => queueVerificationGraph(record, original, { ...registry, evaluators: [{ ...registry.evaluators[0], implementation: { id: 'readback', version: 2 } }] }, bar)).toThrow('ADOPTION_VERIFICATION_MISMATCH');
    expect(() => queueVerificationGraph(record, { ...original, progress: [{ ...original.progress[0]!, phase: 'failed' }] }, registry, bar)).toThrow('ADOPTION_NOT_ACCEPTED');
    // Astra R2: only read-output is withdrawn at claim; prepare-integration stays allowed.
    const revoked = await attempt(false, true);
    await expect(revoked.run()).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(revoked.prepares()).toBe(0);
    expect(revoked.finished()).toBe(0);
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
