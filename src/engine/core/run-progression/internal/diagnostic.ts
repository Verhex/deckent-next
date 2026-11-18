import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import { counterSchema, identitySchema, evaluatePolicy, delegationWithin, type Policy, type RunSnapshot, type VerifiedPrincipal } from '#domain/index.js';
import type { ProgressionCursor } from './journal.js';

/** Ephemeral service observation, deliberately outside RunView and every persisted record. */
export const runProgressionDiagnosticSchema = z.strictObject({
  schemaVersion: z.literal(1), scopeId: identitySchema, runId: identitySchema, revision: counterSchema,
  observedAtMs: counterSchema, validUntilMs: counterSchema,
  state: z.enum(['eligible', 'blocked', 'maintenance-only', 'unknown']), reason: identitySchema,
  actor: z.strictObject({ id: identitySchema, issuer: identitySchema, subject: identitySchema }).optional(), policyRevision: identitySchema.optional(),
  actorClass: z.enum(['ai', 'person']),
  session: z.enum(['eligible', 'ineligible', 'unknown']), suspended: z.boolean(), parkUnavailable: z.boolean(),
  missing: z.array(z.strictObject({ kind: z.enum(['run', 'attempt']), id: identitySchema, action: identitySchema, scope: identitySchema,
    reason: identitySchema, code: z.enum(['POLICY_DENIED', 'POLICY_APPROVAL_UNSUPPORTED']) })).readonly(),
}).readonly();
export type RunProgressionDiagnostic = z.infer<typeof runProgressionDiagnosticSchema>;
type RuntimeObservation = Readonly<{ suspended: boolean; parkUnavailable: boolean }>;
const runtime = new AsyncLocalStorage<{ observation(query: ProgressionCursor): RuntimeObservation }>();
export const withRunProgressionObservation = <T>(source: { observation(query: ProgressionCursor): RuntimeObservation }, work: () => T): T => runtime.run(source, work);
export const runProgressionObservation = (query: ProgressionCursor) => runtime.getStore()?.observation(query);

/** Current concrete policy checks only; never a claim that this refusal happened in a past turn. */
export function runProgressionMissingPermissions(run: RunSnapshot, principal: VerifiedPrincipal, policy: Policy, maintenance: boolean): RunProgressionDiagnostic['missing'] {
  const missing: RunProgressionDiagnostic['missing'][number][] = [], scope = run.identity.scopeId;
  const cells = [
    ...(!maintenance ? ['inspect', 'reserve', 'cancel'].map(action => ({ kind: 'run' as const, id: run.identity.runId, action })) : []),
    ...run.bindings.flatMap(binding => {
      const task = run.progress.find(row => row.taskId === binding.identity.taskId);
      const actions = task?.unresolvedEffects ? [] : task?.phase === 'active' && !maintenance ? ['execute', 'evaluate', 'read-output', 'recover-output']
        : task?.phase === 'evaluating' && binding.observedKind === 'exited' ? ['evaluate', 'read-output', 'recover-output'] : [];
      return actions.map(action => ({ kind: 'attempt' as const, id: binding.identity.attemptId, action }));
    }),
  ];
  for (const cell of cells) {
    const verdict = evaluatePolicy(policy, { principal, scopeId: scope, action: cell.action, resource: { kind: cell.kind, id: cell.id } });
    if (verdict.decision !== 'allow') missing.push({ ...cell, scope, reason: verdict.reason, code: verdict.decision === 'require-approval' ? 'POLICY_APPROVAL_UNSUPPORTED' : 'POLICY_DENIED' });
  }
  return missing;
}

/** A collection-coverage gap cannot prove a refusal for a future concrete attempt id. Kept out of diagnostic.missing. */
export function runProgressionUnreservedCoverage(run: RunSnapshot, principal: VerifiedPrincipal, policy: Policy): RunProgressionDiagnostic['missing'] {
  if (!run.progress.some(task => task.phase === 'pending' && !run.bindings.some(binding => binding.identity.taskId === task.taskId))) return [];
  const gaps: RunProgressionDiagnostic['missing'][number][] = [], scope = run.identity.scopeId;
  for (const action of ['execute', 'evaluate', 'read-output', 'recover-output']) {
    const verdict = delegationWithin(policy, principal, [{ id: 'progression-observation', effect: 'allow', scopes: [scope], actions: [action], resource: { kind: 'attempt', ids: 'all' } }]);
    if (!verdict.ok) gaps.push({ kind: 'attempt', id: 'all', action, scope, reason: verdict.reason === 'no-grant' ? 'NO_GRANT' : verdict.reason === 'deny' ? 'DENIED' : 'APPROVAL_REQUIRED',
      code: verdict.reason === 'require-approval' ? 'POLICY_APPROVAL_UNSUPPORTED' : 'POLICY_DENIED' });
  }
  return gaps;
}
