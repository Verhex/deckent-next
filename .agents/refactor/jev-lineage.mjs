// Host decision lineage. Distinguishes a new decision, a context revision of the same decision and a
// transport retry of the identical request. Recorded beside the request, never sent to the provider.
import { join } from 'node:path';
import { ensure } from './jev-context.mjs';
import { validateCallId, readEvent } from './jev-journal.mjs';
export const RELATIONS = ['new-decision', 'context-revision', 'transport-retry', 'evaluation-replay'];
export const PURPOSES = ['development', 'evaluation', 'control', 'pilot'];
const text = v => typeof v === 'string' && v.trim().length > 0;
const caseIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
async function optional(directory, name) {
  try { return await readEvent(directory, name); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
const next = value => Number.isSafeInteger(value) ? value + 1 : 'unknown';

// meta: { relation, parentCallId, caseId, reason, purpose }. Reads the parent read-only; old parents
// without lineage are unknown-lineage and their counters stay 'unknown' rather than being guessed.
export async function resolveLineage(meta, { root, id, requestSha256, reviewPolicy }) {
  const { relation = 'new-decision', parentCallId = null, caseId = null, reason = null, purpose = 'development', replayOf = null, ...extra } = meta ?? {};
  ensure(Object.keys(extra).length === 0 && RELATIONS.includes(relation) && PURPOSES.includes(purpose), 'JEV_LINEAGE');
  ensure(caseId === null || (typeof caseId === 'string' && caseIdPattern.test(caseId)), 'JEV_LINEAGE');
  ensure(reason === null || text(reason), 'JEV_LINEAGE');
  let lineage;
  // An evaluation replay re-asks a stored case from another journal; it is not part of that decision chain.
  ensure((relation === 'evaluation-replay') === (replayOf !== null), 'JEV_LINEAGE');
  if (relation === 'evaluation-replay') {
    ensure(purpose === 'evaluation' && parentCallId === null && replayOf && typeof replayOf === 'object'
      && Object.keys(replayOf).every(k => ['callId', 'requestSha256', 'inputMode'].includes(k))
      && /^[0-9a-f]{64}$/.test(replayOf.requestSha256 ?? '') && ['stored', 'reprepare'].includes(replayOf.inputMode), 'JEV_LINEAGE');
    validateCallId(replayOf.callId);
    return { schemaVersion: 1, relation, purpose, reason, caseId: caseId ?? replayOf.callId, parentCallId: null, contextRevision: null,
      transportAttempt: 1, parentLineage: null, replayOf: { ...replayOf, journal: 'source' }, exceedsRevisionPolicy: null };
  }
  if (relation === 'new-decision') {
    ensure(parentCallId === null, 'JEV_LINEAGE');
    lineage = { caseId: caseId ?? id, parentCallId: null, contextRevision: 0, transportAttempt: 1, parentLineage: null };
  } else {
    validateCallId(parentCallId);
    const directory = join(root, parentCallId);
    const parent = await readEvent(directory, 'request.json');
    const known = parent.lineage && typeof parent.lineage === 'object' ? parent.lineage : null;
    const derivedCase = known?.caseId ?? parentCallId;
    ensure(caseId === null || caseId === derivedCase, 'JEV_LINEAGE_CASE');
    if (relation === 'context-revision') {
      ensure(text(reason), 'JEV_LINEAGE_REASON');
      // Re-asking an unchanged request is not a revision; it would only chase a different score.
      ensure(parent.requestSha256 !== requestSha256, 'JEV_LINEAGE_UNCHANGED_CONTEXT');
      lineage = { caseId: derivedCase, parentCallId, contextRevision: known ? next(known.contextRevision) : 'unknown', transportAttempt: 1 };
    } else {
      ensure(parent.requestSha256 === requestSha256, 'JEV_RETRY_CHANGED_REQUEST');
      ensure(!(await optional(directory, 'response.json')), 'JEV_RETRY_HAS_ADVICE');
      // A pending or lost record is response-unknown: never a reason for another paid attempt.
      ensure(await optional(directory, 'failure.json'), 'JEV_RETRY_RESPONSE_UNKNOWN');
      lineage = { caseId: derivedCase, parentCallId, contextRevision: known ? known.contextRevision : 'unknown', transportAttempt: known ? next(known.transportAttempt) : 'unknown' };
    }
    lineage.parentLineage = known ? 'known' : 'unknown';
  }
  const max = reviewPolicy?.maxContextRevisions;
  const exceeds = Number.isSafeInteger(max) && Number.isSafeInteger(lineage.contextRevision) ? lineage.contextRevision > max : null;
  // Recorded for lead/owner disposition only; it neither blocks nor authorizes the call.
  return { schemaVersion: 1, relation, purpose, reason, ...lineage, exceedsRevisionPolicy: exceeds };
}
