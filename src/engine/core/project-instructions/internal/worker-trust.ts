import { createHash } from 'node:crypto';
import { commandEnvelopeSchema, encodeCommandProjection, evaluatePolicy, policyResources, type AuthorityDecisionSubject, type VerifiedPrincipal } from '#domain/index.js';
import { ErrorRegistry } from '#platform/index.js';
import type { ProjectInstructionView } from './contract.js';

export interface WorkerInstructionTrustRequest {
  /** The verified caller (the CLI's own OS identity at a witnessed terminal), never an input field. */
  readonly principal: VerifiedPrincipal;
  readonly scopeId: string;
  readonly action: 'trust' | 'revoke';
  /** A fresh id per request: one sealed decision per attempt. */
  readonly commandId: string;
  /** Where workers read the file: the configured work target (null: the project root) and its canonical root. */
  readonly target: string | null;
  readonly root: string;
  /** The selected worker file (registry data) and the exact content digest the person saw on the card. */
  readonly file: string;
  readonly digest: string;
}
export interface WorkerInstructionTrustPorts {
  /** The trusted policy snapshot (policy + bindings) of the scope. */
  readonly policy: unknown;
  /** Seals one `authority-decision` in the project's ledger; throws when it cannot (nothing is trusted then). */
  record(subject: AuthorityDecisionSubject, atMs: number): { readonly event: { readonly eventId: string } };
  /** The trust record change itself (user-global, folder- and digest-bound); runs only after an allowed, sealed decision. */
  apply(): Promise<unknown>;
  now(): number;
}
const hash = (tag: string, input: unknown) => createHash('sha256').update(encodeCommandProjection(tag, input)).digest('hex');
const ACTIONS = Object.freeze({ trust: 'worker-instructions-trust', revoke: 'worker-instructions-revoke' });
/** The config key that selects the worker instruction source: who may choose which file workers read may vouch for its content. */
const RESOURCE = Object.freeze({ kind: policyResources.config.kind, id: 'project:execution.workerInstructions' });

/**
 * DECKENT-MD-WORKERS trust path (alpha.53 F1): trusting (or taking back) the worker instruction file of a work target is decided on the EXISTING
 * `config`/`write` cell for `project:execution.workerInstructions` — the AI floor refuses every AI actor there (`execution` is a protected key) —
 * and sealed as an `authority-decision` (no new audit kind, no new policy resource) BEFORE the trust record changes, for a refusal too.
 * The caller has already passed the terminal witness and checked that the digest is the file's current content.
 */
export async function decideWorkerInstructionTrust(request: WorkerInstructionTrustRequest, ports: WorkerInstructionTrustPorts): Promise<string> {
  const { principal, scopeId } = request;
  const verdict = evaluatePolicy(ports.policy, { principal, scopeId, action: policyResources.config.actions[0], resource: RESOURCE });
  const envelope = commandEnvelopeSchema.parse({ schemaVersion: 1, commandId: request.commandId, scopeId,
    principalRef: { id: principal.id, issuer: principal.issuer, subject: principal.subject }, idempotencyKeyHash: hash('worker-instructions-trust-command:1', request.commandId) });
  const record = ports.record({ kind: 'authority-decision', schemaVersion: 1, envelope, action: ACTIONS[request.action], resource: RESOURCE,
    inputDigest: hash('worker-instructions-trust:1', { action: request.action, target: request.target, root: request.root, file: request.file, digest: request.digest }),
    basisDigest: request.digest, policyDigest: hash('policy:1', ports.policy),
    verdict: { decision: verdict.decision, revision: verdict.revision, reason: verdict.reason, ...(verdict.ruleId === undefined ? {} : { ruleId: verdict.ruleId }) } }, ports.now());
  if (verdict.decision === 'require-approval') throw ErrorRegistry.createError('POLICY_APPROVAL_UNSUPPORTED');
  if (verdict.decision !== 'allow') throw ErrorRegistry.createError('POLICY_DENIED');
  await ports.apply();
  return record.event.eventId;
}

/** Where and which file a worker reads, resolved once from configuration (admission, status and trust use the same answer). */
export interface WorkerInstructionPlace {
  /** The configured work target id (null: the project root) and the folder workers read the file from. */
  readonly target: string | null; readonly root: string;
  readonly source: string; readonly file: string | null; readonly explicit: boolean;
  /** Null when the mechanism is on; otherwise why it is an explicit no-op. */
  readonly off: 'no-execution' | 'source-none' | null;
}
/** One work target's worker instruction file as `coding instructions status` shows it; the content itself is never listed, only its first lines. */
export interface WorkerInstructionStatus extends WorkerInstructionPlace {
  readonly state: 'off' | 'absent' | 'blocked' | 'untrusted' | 'trusted';
  readonly reason: 'size' | 'unsafe' | 'unreadable' | null;
  readonly path: string | null; readonly bytes: number | null; readonly digest: string | null; readonly preview: readonly string[];
}
export interface WorkerInstructionTrustResult {
  readonly schemaVersion: 1; readonly action: 'trust' | 'revoke'; readonly target: string | null; readonly path: string; readonly digest: string;
  readonly trusted: boolean; readonly changed: boolean; readonly decisionEventId: string | null;
}
const PREVIEW = Object.freeze({ lines: 12, chars: 160 });
export function workerInstructionStatus(place: WorkerInstructionPlace, view: ProjectInstructionView | null): WorkerInstructionStatus {
  const none = { reason: null, path: null, bytes: null, digest: null, preview: [] };
  if (view === null) return { ...place, ...none, state: 'off' };
  if (view.status === 'absent') return { ...place, ...none, state: 'absent' };
  if (view.status === 'blocked') return { ...place, ...none, state: 'blocked', reason: view.reason };
  const { path, bytes, digest, content } = view.source, lines = content.split(/\r?\n/u);
  while (lines.length && !lines.at(-1)!.trim()) lines.pop(); // trailing blank lines say nothing on the card
  return { ...place, state: view.status === 'ready' ? 'trusted' : 'untrusted', reason: null, path, bytes, digest,
    preview: lines.slice(0, PREVIEW.lines).map(line => [...line].slice(0, PREVIEW.chars).join('')) };
}
