import { join } from 'node:path';
import { z } from 'zod';
import { beuserBindingSchema } from '#domain/index.js';
import { beuserEvidenceSchema, type ArtifactStore } from '#capabilities/index.js';
import { beuserPrivateRecord } from '#adapters/index.js';
import { BEUSER_LIMITS_REGISTRY, BeuserContractError, SupervisorError, beuserEvaluatorFor, beuserBindingDigest, sameSandboxRequest, sandboxResultSchema,
  beuserDiagnosticSchema, beuserFilesystemProofSchema, type DispatchRecord, type DispatchStore, type ExecutionSupervisor, type SupervisorProfileSource, type SandboxRequest, type BeuserContext } from '#engine/index.js';
import { sha256, inspectProductDirectory, type ResolvedConfig, type ProductLayout } from '#platform/index.js';
import { profileData } from './beuser-profile.js';
import { openConfiguredBeuserRealmOwner } from './beuser-realm.js';

/** Management of a recorded BeUser Attempt never creates a realm, surface or model invocation. */
export function recordedBeuserSupervisor(recorded: DispatchRecord, input: {
  readonly config: ResolvedConfig; readonly layout: ProductLayout; readonly store: Pick<DispatchStore, 'readDispatch'>; readonly artifacts: ArtifactStore;
}): ExecutionSupervisor & SupervisorProfileSource {
  const data = profileData(recorded.profile), limits = BEUSER_LIMITS_REGISTRY.profiles.find(row => row.revision === data.limitsRevision);
  if (!limits) throw new BeuserContractError('BEUSER_INPUT_INVALID');
  const context = (): BeuserContext => { if (!recorded.grant) throw new BeuserContractError('BEUSER_INPUT_INVALID');
    return { binding: data.binding, principal: beuserEvaluatorFor(recorded.grant.principal, recorded.request.identity.scopeId), limits, signal: new AbortController().signal }; };
  let opened: ReturnType<typeof openConfiguredBeuserRealmOwner> | undefined;
  const get = (request: SandboxRequest) => {
    if (!sameSandboxRequest(request, recorded.request)) throw new SupervisorError('SUPERVISOR_IDENTITY_CONFLICT');
    return opened ??= openConfiguredBeuserRealmOwner(input, context(), request, recorded.profile, input.store, input.artifacts, recorded.owner);
  };
  const terminal = async () => {
    const directory = join(await inspectProductDirectory(input.layout, 'crashes'), 'beuser-custody');
    const read = await beuserPrivateRecord(directory, `terminal-${sha256(JSON.stringify(recorded.request.identity))}`, limits.maxArtifactBytes).read();
    if (read.kind !== 'ready') return null;
    const value = z.object({ binding: beuserBindingSchema, result: sandboxResultSchema.nullable(),
      reason: z.string().nullable().optional(), cleanup: z.enum(['destroyed', 'quarantined', 'unknown']).optional(), filesystemProof: beuserFilesystemProofSchema.optional(), evidence: beuserEvidenceSchema.nullable(), diagnostic: beuserDiagnosticSchema.optional() }).strict().parse(read.value);
    if (beuserBindingDigest(value.binding) !== beuserBindingDigest(data.binding)) throw new BeuserContractError('BEUSER_TARGET_NOT_SANDBOX');
    return value;
  };
  const observe = async (request: SandboxRequest) => {
    const owner = await get(request), lease = await owner.custody.load(context());
    if (!lease?.handle) throw new BeuserContractError('BEUSER_TARGET_NOT_SANDBOX');
    const handle = `beuser-${lease.handle.incarnation}`;
    if (lease.observation.state !== 'destroyed' || !lease.observation.evidenceRefs.length) return { handle, result: { kind: 'unknown' as const, reasonCode: 'BEUSER_CLEANUP_UNPROVEN' } };
    const held = await terminal();
    if (held?.result && held.result.handle !== handle) throw new SupervisorError('SUPERVISOR_IDENTITY_CONFLICT');
    return { handle, result: held?.result?.result ?? { kind: 'unknown' as const, reasonCode: 'BEUSER_EXECUTION_UNRESOLVED' } };
  };
  return {
    captureProfile: async () => recorded.profile,
    async execute() { throw new SupervisorError('SUPERVISOR_REQUEST_INVALID'); },
    observe,
    async cancel(request) { const owner = await get(request); await owner.realm.destroy(context()); return observe(request); },
    async recoverOutput(request) { if ((await observe(request)).result.kind !== 'exited') throw new SupervisorError('SUPERVISOR_NOT_TERMINAL');
      return { stdout: '', stderr: '', completeness: 'partial' }; },
    async collectOutputFiles(request) { if ((await observe(request)).result.kind !== 'exited') throw new SupervisorError('SUPERVISOR_NOT_TERMINAL');
      const held = await terminal(); return held?.evidence ? [{ name: 'beuser-evidence', status: 'collected', bytes: Buffer.from(JSON.stringify(held.evidence)) }] : []; },
    async release(request) { if ((await observe(request)).result.kind !== 'exited') throw new SupervisorError('SUPERVISOR_RELEASE_UNCONFIRMED'); return 'absent'; },
    async observeCreatedAbsence(request, containerId) { const owner = await get(request), lease = await owner.custody.load(context());
      if (lease?.handle?.containerId !== containerId) throw new SupervisorError('SUPERVISOR_IDENTITY_CONFLICT');
      return lease.observation.state === 'destroyed' && lease.observation.evidenceRefs.length ? { kind: 'created-container-absent', containerId } : null; },
  };
}
