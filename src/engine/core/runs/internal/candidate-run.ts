import { candidateBindingSchema, CandidateBindingError, encodeCommandProjection, type CandidateBinding, type AttemptIdentity } from '#domain/index.js';
import { runWorkspaceCustodySchema, type RunWorkspaceCustody, type WorkspaceSource } from '#engine/core/workspaces/index.js';
import { runAdmissionSchema, type RunAdmission, type RunAdmissionApplication } from '#engine/core/runs/index.js';

/** Service-only lookup of immutable candidate custody. A client never supplies a path, source binding or revision. */
export interface PrivateCandidateStore { loadCandidate(scopeId: string, commandId: string): Promise<CandidateBinding | null> }
export interface PrivateCandidateWorkspace {
  /** Verifies stored adapter custody (full tree/revision/digest), not just object existence. */
  capture(candidate: CandidateBinding): Promise<{ readonly source: WorkspaceSource; readonly baseRevision: string }>;
}
export interface CandidateRunRequest { readonly scopeId: string; readonly runId: string; readonly candidateCommandId: string }
/** Normal Run admission remains the transition owner. This resolver supplies only the immutable workspace pin after its authorization. */
export async function pinRunToCandidate(store: PrivateCandidateStore, provider: PrivateCandidateWorkspace,
  authorizeRead: (identity: AttemptIdentity) => Promise<void>, request: CandidateRunRequest): Promise<RunWorkspaceCustody> {
  const stored = await store.loadCandidate(request.scopeId, request.candidateCommandId);
  if (!stored) throw new CandidateBindingError('CANDIDATE_MISMATCH');
  const candidate = candidateBindingSchema.parse(stored);
  if (candidate.identity.scopeId !== request.scopeId) throw new CandidateBindingError('CANDIDATE_MISMATCH');
  await authorizeRead(candidate.identity);
  const captured = await provider.capture(candidate);
  if (captured.baseRevision !== candidate.candidateVersion || captured.source.sourceFingerprint !== candidate.sourceBinding)
    throw new CandidateBindingError('CANDIDATE_MISMATCH');
  return runWorkspaceCustodySchema.parse({ schemaVersion: 1, scopeId: request.scopeId, runId: request.runId,
    source: captured.source, baseRevision: captured.baseRevision });
}
export interface CandidateRunCriteria {
  /** Reuse the original Task's pinned evaluator/version/parameters AND the current installation bar.
   * Unknown implementations and weaker criteria fail closed, before any Run is admitted. */
  assert(candidate: CandidateBinding, admission: RunAdmission): Promise<void>;
}
/** No public ingress/exported SDK producer invokes this service capability; credential and authority stay on the normal application. */
export class PrivateCandidateRunAdmission {
  constructor(private readonly app: Pick<RunAdmissionApplication, 'create'>, private readonly store: PrivateCandidateStore,
    private readonly provider: PrivateCandidateWorkspace, private readonly criteria: CandidateRunCriteria,
    private readonly authorizeRead: (identity: AttemptIdentity) => Promise<void>) {}
  async create(input: RunAdmission, candidateCommandId: string, credential?: unknown) {
    const command = runAdmissionSchema.parse(input), candidate = await this.store.loadCandidate(command.scopeId, candidateCommandId);
    if (!candidate || candidate.identity.scopeId !== command.scopeId) throw new CandidateBindingError('CANDIDATE_MISMATCH');
    await this.authorizeRead(candidate.identity); await this.criteria.assert(candidate, command);
    const frozen = encodeCommandProjection('private-candidate:1', candidate);
    return this.app.create(command, credential, async () => {
      const current = await this.store.loadCandidate(command.scopeId, candidateCommandId);
      if (!current || encodeCommandProjection('private-candidate:1', current) !== frozen) throw new CandidateBindingError('CANDIDATE_MISMATCH');
      return pinRunToCandidate(this.store, this.provider, this.authorizeRead, { scopeId: command.scopeId, runId: command.runId, candidateCommandId });
    });
  }
}
