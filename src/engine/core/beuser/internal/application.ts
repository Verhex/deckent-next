import { beuserVerdictSchema, type BeuserVerdict, type BeuserWalkerSummary } from '#domain/index.js';
import { BeuserContractError, assertBeuserAccess, type BeuserContext, type RealmPort, type EvidencePort, type BeuserRealmObservation, type BeuserFilesystemProof } from '#engine/core/beuser-contract/index.js';
import { BeuserController, BeuserWalkStopped, beuserBounded, beuserDeadline, type BeuserExecutionBudget } from './controller.js';
import { walkBeuser } from './walker.js';
import { encodeCommandProjection } from '#domain/index.js';
import { sha256 } from '#platform/index.js';
import { pinBeuserWalkerSummary } from '#engine/core/beuser-contract/index.js';

import type { SandboxResult } from '#engine/core/supervisor/index.js';
import type { BeuserControllerValidity } from './controller-audit.js';

type WalkerPorts = Parameters<typeof walkBeuser>[1];
export interface BeuserWalkPorts extends WalkerPorts {
  readonly realm: RealmPort; readonly evidence: EvidencePort;
  readonly controllerAudit: (context: BeuserContext) => Promise<BeuserControllerValidity>;
  readonly refusal: (context: BeuserContext) => Promise<void>;
}
export interface BeuserWalkResult {
  readonly binding: BeuserContext['binding']; readonly verdict: BeuserVerdict | null;
  readonly state: 'completed' | 'unknown' | 'invalid'; readonly reason: string | null;
  readonly filesystemProof?: BeuserFilesystemProof;
  readonly cleanup: 'destroyed' | 'quarantined' | 'unknown'; readonly transcriptDigest: string | null;
}
export class BeuserApplication {
  constructor(private readonly ports: BeuserWalkPorts, private readonly budget?: BeuserExecutionBudget) {}
  async walk(context: BeuserContext, summary: BeuserWalkerSummary): Promise<BeuserWalkResult> {
    const startedAt = performance.now();
    summary = pinBeuserWalkerSummary(summary);
    if (sha256(encodeCommandProjection('beuser-persona:1', summary)) !== context.binding.personaDigest) throw new BeuserContractError('BEUSER_INPUT_INVALID');
    const controller = new BeuserController(context, summary, this.budget);
    let verdict: BeuserVerdict | null = null, state: BeuserWalkResult['state'] = 'unknown', reason: string | null = null;
    let filesystemProof: BeuserFilesystemProof = { schemaVersion: 1, source: 'unknown' };
    let transcriptDigest: string | null = null, cleanup: BeuserWalkResult['cleanup'] = 'unknown';
    const checkRealm = (observation: BeuserRealmObservation, expected: BeuserRealmObservation['state']) => {
      assertBeuserAccess(controller.context, observation.binding, context.principal, { kind: 'beuser-sandbox', id: observation.binding.realmId }, 'create');
      if (observation.state !== expected || expected === 'admitted' && !observation.evidenceRefs.length) throw new BeuserWalkStopped('unknown');
      return observation;
    };
    try {
      const created = checkRealm(await controller.call('beuser-sandbox', 'create', ctx => this.ports.realm.create(ctx)), 'created');
      checkRealm(await controller.call('beuser-sandbox', 'create', ctx => this.ports.realm.admit(ctx, created)), 'admitted');
      await walkBeuser(controller, this.ports);
      const finalized = await controller.call('beuser-transcript', 'inspect', ctx => this.ports.evidence.finalize(ctx));
      assertBeuserAccess(controller.context, finalized.binding, context.principal, { kind: 'beuser-transcript', id: finalized.binding.transcriptId }, 'inspect');
      if (!/^[a-f0-9]{64}$/u.test(finalized.transcriptDigest) || !finalized.evidenceRefs.length) throw new BeuserWalkStopped('unknown');
      transcriptDigest = finalized.transcriptDigest;
    } catch (error) {
      reason = error instanceof BeuserWalkStopped ? error.reason : error instanceof BeuserContractError ? error.code
        : error instanceof DOMException && error.name === 'TimeoutError' ? 'deadline' : error instanceof DOMException && error.name === 'AbortError' ? 'cancelled' : 'unknown';
      if (reason === 'BEUSER_TARGET_NOT_SANDBOX') {
        state = 'invalid';
        // No cleanup/effect follows a failed audit append. Caller retains custody for reconciliation.
        try { await this.ports.refusal(context); } catch (auditError) { controller.close(); throw auditError; }
      } else if (reason === 'drift' || reason === 'leak') state = 'invalid';
    }
    controller.close();
    // Cleanup has separate authority-preserving cancellation: an aborted walk must not prevent bounded destruction.
    const cleanupStartedAt = performance.now(), deadline = beuserDeadline(context.limits.cleanupDeadlineMs), cleanupContext = { ...context, signal: deadline.signal };
    try {
      assertBeuserAccess(cleanupContext, context.binding, context.principal, { kind: 'beuser-sandbox', id: context.binding.realmId }, 'destroy');
      const destroyed = await beuserBounded(deadline.signal, () => this.ports.realm.destroy(cleanupContext));
      assertBeuserAccess(cleanupContext, destroyed.binding, context.principal, { kind: 'beuser-sandbox', id: destroyed.binding.realmId }, 'destroy');
      filesystemProof = destroyed.filesystemProof ?? filesystemProof;
      if (destroyed.state === 'destroyed' && destroyed.evidenceRefs.length) cleanup = 'destroyed';
    } catch { /* Uncertain destruction never becomes proof of absence. */ }
    finally { deadline.close(); }
    if (cleanup !== 'destroyed') {
      const remaining = context.limits.cleanupDeadlineMs - (performance.now() - cleanupStartedAt);
      const quarantineDeadline = beuserDeadline(Math.max(0, remaining)), ctx = { ...context, signal: quarantineDeadline.signal };
      try {
        assertBeuserAccess(ctx, context.binding, context.principal, { kind: 'beuser-sandbox', id: context.binding.realmId }, 'destroy');
        const quarantined = await beuserBounded(ctx.signal, () => this.ports.realm.quarantine(ctx, reason ?? 'unknown'));
        assertBeuserAccess(ctx, quarantined.binding, ctx.principal, { kind: 'beuser-sandbox', id: quarantined.binding.realmId }, 'destroy');
        if (quarantined.state === 'quarantined' && quarantined.evidenceRefs.length) cleanup = 'quarantined';
      } catch { /* Keep both the realm and the unknown custody for the existing owner. */ }
      finally { quarantineDeadline.close(); }
      if (state !== 'invalid') state = 'unknown';
    }
    const auditDeadline = beuserDeadline(context.limits.maxWaitMs);
    let controllerValidity: BeuserControllerValidity = 'unknown';
    try { controllerValidity = await beuserBounded(auditDeadline.signal, () => this.ports.controllerAudit({ ...context, signal: auditDeadline.signal })); }
    catch { /* Missing controller evidence never grants validity. */ }
    finally { auditDeadline.close(); }
    if (controllerValidity === 'invalid') { state = 'invalid'; reason = 'BEUSER_TARGET_NOT_SANDBOX'; await this.ports.refusal(context); }
    else if (controllerValidity === 'unknown' && state !== 'invalid') { state = 'unknown'; reason ??= 'unknown'; }
    // C5's retained verdict requires the outer controller's destruction proof; never read a pre-cleanup verdict.
    const remainingWallMs = context.limits.maxWallMs - (performance.now() - startedAt);
    if (cleanup === 'destroyed' && transcriptDigest && !context.signal.aborted && remainingWallMs > 0) {
      const readDeadline = beuserDeadline(Math.min(context.limits.maxWaitMs, remainingWallMs)), readContext = { ...context, signal: AbortSignal.any([context.signal, readDeadline.signal]) };
      try {
        const readback = await beuserBounded(readContext.signal, () => this.ports.evidence.readback(readContext));
        assertBeuserAccess(readContext, readback.binding, context.principal, { kind: 'beuser-transcript', id: readback.binding.transcriptId }, 'inspect');
        if (readback.verdict) {
          const checked = beuserVerdictSchema.parse(readback.verdict);
          assertBeuserAccess(readContext, checked.binding, context.principal, { kind: 'attempt', id: checked.binding.identity.attemptId }, 'evaluate');
          if (checked.transcriptDigest !== transcriptDigest) throw new BeuserWalkStopped('drift');
          if (controllerValidity === 'valid' && state !== 'invalid') {
            verdict = checked;
            state = verdict.validity === 'unknown' ? 'unknown' : verdict.validity !== 'valid' ? 'invalid' : verdict.outcome === 'unknown' ? 'unknown' : 'completed';
          }
        }
      } catch (error) {
        reason = error instanceof BeuserWalkStopped ? error.reason : error instanceof BeuserContractError ? error.code
        : error instanceof DOMException && error.name === 'TimeoutError' ? 'deadline' : error instanceof DOMException && error.name === 'AbortError' ? 'cancelled' : 'unknown';
        if (reason === 'drift' || reason === 'BEUSER_TARGET_NOT_SANDBOX') state = 'invalid';
        if (reason === 'BEUSER_TARGET_NOT_SANDBOX') await this.ports.refusal(context);
      }
      finally { readDeadline.close(); }
    }
    return Object.freeze({ binding: context.binding, verdict, state, reason, cleanup, filesystemProof, transcriptDigest });
  }
}

/** A refusal is a failed walk, not a fabricated timeout. Cleanup remains independently unproven. */
export function beuserWalkSandboxResult(handle: string, walk: BeuserWalkResult): SandboxResult {
  const interruptCause = walk.reason === 'cancelled' ? 'cancel' : walk.reason === 'deadline' ? 'deadline' : undefined;
  return { handle, result: walk.cleanup === 'destroyed'
    ? { kind: 'exited', exitCode: walk.reason !== null || walk.state === 'invalid' ? 1 : 0 }
    : { kind: 'unknown', reasonCode: walk.reason ?? 'BEUSER_CLEANUP_UNPROVEN' },
    stdout: '', stderr: '', outputCompleteness: 'complete', interrupted: interruptCause !== undefined,
    ...(interruptCause ? { interruptCause } : {}) };
}
