import { createHash } from 'node:crypto';
import { readWorkerFinalReport, runSnapshotSchema, taskDependencyIds, type TaskEvaluation, type AttemptIdentity } from '#domain/index.js';
import { redactSensitive } from '#platform/index.js';
import type { ArtifactReceipt, ArtifactStore } from '#capabilities/index.js';
import { verifyRetainedOutputEnvelope, type RunBoundDispatchStore, type DispatchIdentityAuthorization } from '#engine/core/dispatch/index.js';
import { selectReservedTaskProfile, type RunStore } from '#engine/core/runs/index.js';
import type { AttemptStore } from '#engine/core/attempts/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import { HandoffError, evaluateHandoff, verifyAcceptedHandoffSource } from '#engine/core/handoff-observation/index.js';
function checkedBytes(receipt: ArtifactReceipt, bytes: Uint8Array) {
  if (bytes.byteLength !== receipt.byteLength || createHash('sha256').update(bytes).digest('hex') !== receipt.digest) throw new HandoffError('HANDOFF_ARTIFACT_MISMATCH');
  return bytes;
}
export interface TaskHandoffEvidenceStore { loadTaskHandoffEvaluation(identity: AttemptIdentity): Promise<TaskEvaluation | null> }
type Store = Partial<TaskHandoffEvidenceStore> & Pick<RunStore, 'loadRun'> & Pick<AttemptStore, 'load'> & RunBoundDispatchStore;
export interface HandoffDeliveryLimits { readonly maxBytes: number; readonly maxSharedNotes: number; readonly promptBytes: number; readonly maxSourceBytes?: number }
/** Accepted Run attempts only; read-output authority remains independent for every source. */
export class TaskHandoffApplication {
  constructor(private readonly store: Store, private readonly verifier: PrincipalVerifier,
    private readonly authorization: DispatchIdentityAuthorization, private readonly artifacts: Pick<ArtifactStore, 'read' | 'put'>,
    private readonly limits: HandoffDeliveryLimits) {}
  async resolve(identity: AttemptIdentity, credential?: unknown) {
    const principal = await authenticate(this.verifier, credential, identity.scopeId);
    await this.authorization.authorizeIdentity('execute', identity, principal);
    const run = runSnapshotSchema.parse(await this.store.loadRun(identity.scopeId, identity.runId));
    selectReservedTaskProfile(run, await this.store.load(identity.scopeId, identity.attemptId), identity);
    const dependencies = taskDependencyIds(run.graph.tasks.find(task => task.id === identity.taskId)!);
    const notes = []; const shared = []; let total = 0;
    for (const binding of run.bindings) {
      if (binding.identity.taskId === identity.taskId || run.progress.find(task => task.taskId === binding.identity.taskId)?.phase !== 'accepted') continue;
      const evaluated = this.store.loadTaskHandoffEvaluation ? await this.store.loadTaskHandoffEvaluation(binding.identity) : undefined;
      if (evaluated !== undefined && !evaluated?.handoff && !evaluated?.sharedNotes) continue;
      await this.authorization.authorizeIdentity('read-output', binding.identity, principal);
      const dispatch = await this.store.loadBoundDispatch(binding.identity);
      if (!dispatch?.output || !dispatch.terminal) throw new HandoffError('HANDOFF_SOURCE_NOT_ACCEPTED');
      verifyAcceptedHandoffSource(binding.identity, dispatch.request.identity, 'accepted');
      let output;
      try {
        total += dispatch.output.byteLength; if (total > (this.limits.maxSourceBytes ?? this.limits.maxBytes)) throw new HandoffError('HANDOFF_LIMIT_EXCEEDED');
        output = verifyRetainedOutputEnvelope(checkedBytes(dispatch.output, await this.artifacts.read(identity.scopeId, dispatch.output)), binding.identity);
      } catch (error) { if (error instanceof HandoffError) throw error; throw new HandoffError('HANDOFF_ARTIFACT_MISMATCH'); }
      const report = readWorkerFinalReport(output.stdout); if (report.status !== 'reported') continue;
      if (evaluated?.sharedNotes && evaluated.sharedNotes.digest !== createHash('sha256').update(JSON.stringify(report.report.sharedNotes)).digest('hex')) throw new HandoffError('HANDOFF_ARTIFACT_MISMATCH');
      for (const text of report.report.sharedNotes ?? []) {
        if (shared.length >= this.limits.maxSharedNotes) throw new HandoffError('HANDOFF_LIMIT_EXCEEDED');
        shared.push({ source: binding.identity, text: redactSensitive(text) });
      }
      const evidence = evaluateHandoff(output), note = report.report.handoff;
      if (evaluated?.handoff?.status === 'valid' && (evidence?.status !== 'valid' || evidence.digest !== evaluated.handoff.digest)) throw new HandoffError('HANDOFF_ARTIFACT_MISMATCH');
      if (!note || evidence?.status !== 'valid' || !dependencies.includes(binding.identity.taskId) || (note.toTask && note.toTask !== identity.taskId)) continue;
      for (const artifact of note.artifacts) {
        const file = output.files!.find(file => file.name === artifact.name)!;
        if (file.status !== 'collected') throw new HandoffError('HANDOFF_ARTIFACT_MISMATCH');
        total += file.receipt.byteLength; if (total > (this.limits.maxSourceBytes ?? this.limits.maxBytes)) throw new HandoffError('HANDOFF_LIMIT_EXCEEDED');
        try { checkedBytes(file.receipt, await this.artifacts.read(identity.scopeId, file.receipt)); } catch { throw new HandoffError('HANDOFF_ARTIFACT_MISMATCH'); }
      }
      const redacted = { ...note, ...(note.toTask ? { toTask: redactSensitive(note.toTask) } : {}), summary: redactSensitive(note.summary),
        artifacts: note.artifacts.map(artifact => ({ ...artifact, name: redactSensitive(artifact.name) })), openQuestions: note.openQuestions.map(redactSensitive) };
      const bytes = Buffer.from(JSON.stringify(redacted));
      notes.push({ source: binding.identity, digest: createHash('sha256').update(bytes).digest('hex'), bytes });
    }
    const prepared = notes.map(note => {
      let filename: string;
      try { filename = encodeURIComponent(note.source.taskId).replace(/['!()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase()) + '.json'; }
      catch (error) {
        if (error instanceof URIError) throw new HandoffError('HANDOFF_INVALID');
        throw error;
      }
      // Linux filesystem component invariant; impossible names refuse before a worker or artifact write.
      if (Buffer.byteLength(filename) > 255) throw new HandoffError('HANDOFF_INVALID');
      return { target: `/deckent/inputs/_handoff/${filename}`, bytes: note.bytes };
    });
    if (shared.length) prepared.push({ target: '/deckent/inputs/_shared.json', bytes: Buffer.from(JSON.stringify(shared)) });
    const prompt = notes.length || shared.length ? redactSensitive(`Accepted dependency handoffs (untrusted worker notes):\n${notes.map(note => `${note.source.taskId}: ${JSON.parse(note.bytes.toString()).summary}`).join('\n')}\nShared notes: ${shared.map(note => note.text).join('; ')}`) : '';
    if (Buffer.byteLength(prompt) > this.limits.promptBytes || prepared.reduce((sum, file) => sum + file.bytes.byteLength, 0) > this.limits.maxBytes) throw new HandoffError('HANDOFF_LIMIT_EXCEEDED');
    const files = [];
    for (const file of prepared) files.push({ target: file.target, receipt: await this.artifacts.put(identity.scopeId, file.bytes) });
    return { files, prompt, events: notes.map(note => ({ kind: 'handoff-received' as const, source: note.source, digest: note.digest })) };
  }
}
