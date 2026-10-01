import { attemptIdentitySchema, sameAttemptIdentity, type AttemptIdentity } from '#domain/index.js';
import type { ArtifactReceipt, ArtifactStore } from '#capabilities/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import { DispatchApplication, type DispatchAuthorization, type DispatchIdentityAuthorization, type DispatchInventoryStore, type DispatchRecord,
  type DispatchStore, type RunBoundDispatchStore } from '#engine/core/dispatch/index.js';
import type { WorkspaceRequest } from '#engine/core/workspaces/index.js';
import { workspacePatchSchema, type WorkspacePatch } from './contract.js';
type SupervisorProfile = DispatchRecord['profile']; type Supervisor = ConstructorParameters<typeof DispatchApplication>[1];

/** EXEC-RELEASE (owner D8 A): why an attempt's stopped container and Git clone stay held. Never thrown: release is a step after the
 * retained patch and never changes an execution, evaluation or preparation outcome. `code` is the underlying typed error code. */
export type AttemptCustodyHoldReason = 'retention-keep' | 'release-denied' | 'record-unreadable' | 'not-terminal' | 'patch-missing' | 'patch-mismatch' | 'patch-corrupt'
  | 'events-unsealed' | 'container-release-failed' | 'workspace-release-failed';
type Removal = 'removed' | 'absent' | 'unknown';
export type AttemptCustodyOutcome = Readonly<{ schemaVersion: 1; status: 'released'; container: Removal; workspace: Removal }
  | { schemaVersion: 1; status: 'held'; reason: AttemptCustodyHoldReason; code: string | null }>;
export type AttemptCustodyRetention = Readonly<{ release: 'after-retained-patch' | 'keep'; sweepLimit: number }>;
export type AttemptCustodySweepEntry = Readonly<{ identity: AttemptIdentity; outcome: AttemptCustodyOutcome }>;
/** `detachedKept`: detached (interrupted) removals left in the shared root, counted only; each is completed solely by its own attempt's
 * authorized release, never by a scope-wide sweep (Sol ER-R2). */
export type AttemptCustodySweep = Readonly<{ schemaVersion: 1; scopeId: string; released: number; detachedKept: number; entries: readonly AttemptCustodySweepEntry[];
  error: string | null }>;
/** Trusted adapter for the recorded clone: exact request + path checks. `releaseAttempt` also completes this attempt's own interrupted
 * detach (verified lease inside it). `holds` (directory or own detached removal present) is a work filter only, never eligibility. */
export interface AttemptWorkspaceCustody {
  releaseAttempt(request: WorkspaceRequest, workspace: string): Promise<'removed' | 'absent'>;
  holds(identity: AttemptIdentity): Promise<boolean>;
  countDetached(): Promise<number>;
}
export interface AttemptCustodyPorts {
  /** `loadSealedWorkerEvents`: the attempt's sealed worker event stream verified against its exact identity, receipt digest and event
   * schema; null when none was sealed, a thrown typed error when it does not verify. */
  readonly store: DispatchStore & RunBoundDispatchStore & DispatchInventoryStore
    & { loadSealedWorkerEvents(identity: AttemptIdentity, artifacts: Pick<ArtifactStore, 'read'>): Promise<readonly unknown[] | null> };
  readonly artifacts: ArtifactStore; readonly verifier: PrincipalVerifier;
  readonly authorization: DispatchAuthorization & DispatchIdentityAuthorization; readonly owner: string;
  /** Supervisor restored from the record's own persisted profile, never from current execution config. */
  readonly supervisor: (profile: SupervisorProfile) => Supervisor;
  /** Whether the record's persisted profile ran with a worker event channel, so a sealed event log is required (throws = required). */
  readonly observed: (profile: SupervisorProfile) => boolean;
  readonly workspaces: AttemptWorkspaceCustody; readonly retention: AttemptCustodyRetention;
}
const codeOf = (error: unknown) => error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : null;
const held = (reason: AttemptCustodyHoldReason, code: string | null = null): AttemptCustodyOutcome => Object.freeze({ schemaVersion: 1, status: 'held', reason, code });

/** Single owner of the attempt custody release transition. Eligibility comes only from the ledger: a terminal record whose retained
 * patch receipt reads back with its digest, parses and binds this exact attempt, plus a sealed worker event log when the recorded profile
 * had an event channel. Order: container (the existing release authority re-verifies retained output and the exact terminal container)
 * then clone (detached atomically, then removed); a failed step stops, keeps the rest and is retryable by preparation or the start sweep.
 */
export class AttemptCustodyReleaseApplication {
  constructor(private readonly ports: AttemptCustodyPorts) {}
  private async verifiedPatch(identity: AttemptIdentity, record: DispatchRecord, expected?: ArtifactReceipt): Promise<WorkspacePatch | AttemptCustodyOutcome> {
    if (!record.patch) return held('patch-missing');
    if (expected && JSON.stringify(expected) !== JSON.stringify(record.patch)) return held('patch-mismatch');
    try {
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await this.ports.artifacts.read(identity.scopeId, record.patch)));
      const patch = workspacePatchSchema.safeParse(value);
      if (!patch.success || !sameAttemptIdentity(identity, patch.data.identity) || !sameAttemptIdentity(identity, record.request.identity)) return held('patch-corrupt');
      return patch.data;
    } catch (error) { return held('patch-corrupt', codeOf(error)); }
  }
  /** Lead (a′) / Sol ER-R1: the live event sidecar inside the attempt directory is the only copy until sealed, so an observed worker needs
   * its sealed stream read back and verified (a valid zero-event stream counts); an unreadable profile counts as observed. */
  private async unsealed(identity: AttemptIdentity, record: DispatchRecord) {
    let required = true; try { required = this.ports.observed(record.profile); } catch { /* uncertainty keeps custody */ }
    return required && (await this.ports.store.loadSealedWorkerEvents(identity, this.ports.artifacts)) === null;
  }
  /** `expected` is the receipt the caller just retained (preparation); the start sweep passes none and relies on the ledger receipt. */
  async release(input: unknown, expected?: ArtifactReceipt, credential?: unknown): Promise<AttemptCustodyOutcome> {
    const identity = attemptIdentitySchema.parse(input); const p = this.ports;
    if (p.retention.release === 'keep') return held('retention-keep');
    try { await p.authorization.authorizeIdentity('release', identity, await authenticate(p.verifier, credential, identity.scopeId)); }
    catch (error) { return held('release-denied', codeOf(error)); }
    let record: DispatchRecord | null;
    try { record = await p.store.loadBoundDispatch(identity); } catch (error) { return held('record-unreadable', codeOf(error)); }
    if (!record?.terminal) return held('not-terminal');
    const patch = await this.verifiedPatch(identity, record, expected);
    if ('status' in patch) return patch;
    try { if (await this.unsealed(identity, record)) return held('events-unsealed'); } catch (error) { return held('events-unsealed', codeOf(error)); }
    let container: Removal;
    try { container = await new DispatchApplication(p.store, p.supervisor(record.profile), p.verifier, p.authorization, p.owner, p.artifacts).release(record.request, credential) ?? 'unknown'; }
    catch (error) { return held('container-release-failed', codeOf(error)); }
    try {
      const workspace = await p.workspaces.releaseAttempt({ schemaVersion: 1, identity, baseCommit: patch.baseCommit }, record.request.workspace);
      return Object.freeze({ schemaVersion: 1, status: 'released', container, workspace });
    } catch (error) { return held('workspace-release-failed', codeOf(error)); }
  }
  /** Bounded start sweep of one scope: ledger-terminal records with a retained patch whose attempt directory (or own interrupted detach)
   * still exists; each goes through the same authorized `release`. At most `sweepLimit` release attempts; one bad record never stops it. */
  async sweep(scopeId: string, pageSize: number, credential?: unknown): Promise<AttemptCustodySweep> {
    const p = this.ports; const limit = p.retention.release === 'keep' ? 0 : p.retention.sweepLimit;
    const entries: AttemptCustodySweepEntry[] = []; let after: string | null = null, error: string | null = null, detachedKept = 0;
    try {
      while (entries.length < limit) {
        const page = await p.store.listDispatches({ schemaVersion: 1, scopeId, after, limit: pageSize });
        for (const entry of page.entries) {
          if (entries.length >= limit || !entry.terminal) continue;
          try {
            const record = await p.store.loadBoundDispatch(entry.identity);
            if (!record?.terminal || !record.patch || !(await p.workspaces.holds(entry.identity))) continue;
          } catch (failure) { entries.push({ identity: entry.identity, outcome: held('record-unreadable', codeOf(failure)) }); continue; }
          entries.push({ identity: entry.identity, outcome: await this.release(entry.identity, undefined, credential) });
        }
        if ((after = page.nextAfter) === null) break;
      }
      detachedKept = await p.workspaces.countDetached();
    } catch (failure) { error = codeOf(failure) ?? 'ATTEMPT_CUSTODY_SWEEP_FAILED'; }
    return Object.freeze({ schemaVersion: 1, scopeId, released: entries.filter(entry => entry.outcome.status === 'released').length, detachedKept,
      entries: Object.freeze(entries), error });
  }
}
/** Start sweep over the installation's scopes; a scope that cannot be opened is reported with its typed code and the others continue. */
export async function sweepAttemptCustodyScopes(scopeIds: readonly string[], sweep: (scopeId: string) => Promise<AttemptCustodySweep | null>,
  failure: (error: unknown) => string): Promise<readonly AttemptCustodySweep[]> {
  const results: AttemptCustodySweep[] = [];
  for (const scopeId of scopeIds) {
    try { const result = await sweep(scopeId); if (result) results.push(result); }
    catch (error) { results.push(Object.freeze({ schemaVersion: 1, scopeId, released: 0, detachedKept: 0, entries: [], error: failure(error) })); }
  }
  return Object.freeze(results);
}
