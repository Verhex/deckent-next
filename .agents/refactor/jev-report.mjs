// Development-host readout only. Missing follow-ups remain unobserved, never a verdict.
import { join } from 'node:path';
import { ensure, instant } from './jev-context.mjs';
import { entries, readEvent } from './jev-journal.mjs';
export const DEFAULT_SCAN_LIMIT = 10000;
async function optional(directory, name) {
  try { return await readEvent(directory, name); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
const count = (rows, predicate) => rows.filter(predicate).length;
const quantile = (values, fraction) => values.length ? values[Math.ceil(values.length * fraction) - 1] : null;
// Known counts only; 'unknown' (null/missing metering), failures and unrecorded responses are counted, never zero-filled.
export const knownCount = v => Number.isSafeInteger(v) && v >= 0;
export function rowUsage(response, failure) {
  if (response) return { inputTokens: knownCount(response.usage?.input_tokens) ? response.usage.input_tokens : 'unknown',
    outputTokens: knownCount(response.usage?.output_tokens) ? response.usage.output_tokens : 'unknown' };
  return { inputTokens: 'unknown', outputTokens: 'unknown', basis: failure ? 'failed-attempt' : 'response-unknown' };
}
export const ABSTENTIONS = ['none_of_the_above', 'insufficient_information', 'defer'];
export const DISPOSITIONS = ['thresholds-met', 'below-choice', 'below-sufficiency', 'below-both', 'abstained', 'incomplete', 'unavailable', 'response-unknown', 'thresholds-unknown'];
// Advice disposition against owner review criteria. Raw >= comparison (0.66 stays below 0.67).
// It classifies advice for the lead/owner; it is never an execution, approval or acceptance gate.
export function adviceDisposition({ status, recommendation, selectedProbability, sufficiency }, reviewPolicy) {
  if (status === 'unavailable' || status === 'response-unknown') return status;
  if (ABSTENTIONS.includes(recommendation)) return 'abstained';
  if (!reviewPolicy) return 'thresholds-unknown';
  if (!Number.isFinite(selectedProbability) || !Number.isFinite(sufficiency)) return 'incomplete';
  const choice = selectedProbability >= reviewPolicy.minSelectedProbability; const context = sufficiency >= reviewPolicy.minSufficiency;
  return choice && context ? 'thresholds-met' : !choice && !context ? 'below-both' : choice ? 'below-sufficiency' : 'below-choice';
}
const policyThresholds = p => p && typeof p === 'object' && Number.isFinite(p.minSelectedProbability) && Number.isFinite(p.minSufficiency) ? p : null;
function lineageSummary(rows) {
  const known = rows.filter(r => r.lineage !== 'unknown');
  const digests = new Map();
  for (const r of rows) if (typeof r.requestSha256 === 'string') digests.set(r.requestSha256, (digests.get(r.requestSha256) ?? 0) + 1);
  const repeated = [...digests.values()].filter(n => n > 1);
  const revisions = known.map(r => r.lineage.contextRevision).filter(Number.isSafeInteger);
  return { known: known.length, unknown: rows.length - known.length,
    relations: Object.fromEntries(['new-decision', 'context-revision', 'transport-retry'].map(rel => [rel, count(known, r => r.lineage.relation === rel)])),
    cases: new Set(known.map(r => r.lineage.caseId)).size, maxContextRevision: revisions.length ? Math.max(...revisions) : null,
    exceedsRevisionPolicy: count(known, r => r.lineage.exceedsRevisionPolicy === true),
    repeatedRequestDigests: { groups: repeated.length, extraAttempts: repeated.reduce((sum, n) => sum + n - 1, 0) },
    basis: 'recorded lineage only; legacy records are unknown-lineage and are never linked by inference' };
}
// Dated list-price estimate from review config pricing. Not an invoice: failed or unrecorded usage,
// credits, taxes and historical tariff changes are unknown. Unknown usage or an unpriced model -> null.
export function estimateUsd(model, usage, pricing) {
  const price = pricing?.models && Object.hasOwn(pricing.models, model) ? pricing.models[model] : null;
  if (!price) return null;
  const part = (tokens, rate) => rate === 0 ? 0 : knownCount(tokens) ? tokens * rate / 1e6 : null;
  const input = part(usage.inputTokens, price.inputPerMillionTokens); const output = part(usage.outputTokens, price.outputPerMillionTokens);
  return input === null || output === null ? null : input + output;
}
const latencyOf = rows => { const v = rows.filter(r => Number.isFinite(r.latencyMs)).map(r => r.latencyMs).sort((a, b) => a - b);
  return { samples: v.length, p50Ms: quantile(v, 0.5), p95Ms: quantile(v, 0.95) }; };
export function latencyByResult(rows) {
  return { success: latencyOf(rows.filter(r => r.status === 'advice')), failure: latencyOf(rows.filter(r => r.status === 'unavailable')),
    basis: 'success: transport start to validated reply; failure: around the attempt; different boundaries, reported separately' };
}
export function costSummary(rows, pricing) {
  const priced = rows.filter(r => r.estimatedUsd !== null);
  return { estimatedUsd: priced.reduce((sum, r) => sum + r.estimatedUsd, 0), pricedAttempts: priced.length, costUnknownAttempts: rows.length - priced.length,
    currency: pricing?.currency ?? null, prices: pricing?.models ?? null, basis: 'list-price estimate from review config pricing applied to known usage; not an invoice' };
}
export function followUpSummary(rows) {
  return { adviceCalls: count(rows, r => r.status === 'advice'), decisionsRecorded: count(rows, r => r.decisionRecorded),
    adviceWithoutDecision: count(rows, r => r.status === 'advice' && !r.decisionRecorded),
    outcomesRecorded: count(rows, r => r.outcomeRecorded), decisionsWithoutOutcome: count(rows, r => r.decisionRecorded && !r.outcomeRecorded),
    callsWithoutOutcome: count(rows, r => !r.outcomeRecorded),
    outcomeCounts: Object.fromEntries(['verified', 'failed', 'inconclusive', 'unobserved'].map(status => [status, count(rows, r => r.outcome === status)])),
    recordingGapIsFailure: false, pendingOrOmittedIsUnknown: true };
}
function slice(rows, keyOf, pricing) {
  const groups = new Map();
  for (const r of rows) { const k = keyOf(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  return Object.fromEntries([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, group]) => [k, {
    calls: group.length, advice: count(group, r => r.status === 'advice'), unavailable: count(group, r => r.status === 'unavailable'),
    responseUnknown: count(group, r => r.status === 'response-unknown'), usage: usageSummary(group), cost: costSummary(group, pricing),
    latency: latencyByResult(group), followUp: followUpSummary(group),
    adviceDispositions: Object.fromEntries(DISPOSITIONS.map(d => [d, count(group, r => r.adviceDisposition === d)])),
    failureErrors: Object.fromEntries([...new Set(group.filter(r => r.failure).map(r => r.failure.error))].sort().map(e => [e, count(group, r => r.failure?.error === e)])) }]));
}
export function usageSummary(rows) {
  const known = field => rows.filter(r => knownCount(r.usage[field]));
  const sum = field => known(field).reduce((total, r) => total + r.usage[field], 0);
  return { inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), knownTokensOnly: true,
    coverage: { attempts: rows.length, inputKnown: known('inputTokens').length, inputUnknown: rows.length - known('inputTokens').length,
      outputKnown: known('outputTokens').length, outputUnknown: rows.length - known('outputTokens').length,
      adviceWithUnknownUsage: count(rows, r => r.status === 'advice' && (!knownCount(r.usage.inputTokens) || !knownCount(r.usage.outputTokens))),
      failedAttemptsUnknownUsage: count(rows, r => r.status === 'unavailable'), responseUnknownAttempts: count(rows, r => r.status === 'response-unknown') },
    excludesFailedAndUnrecordedUsage: true, unknownIsNotZero: true };
}
// Decisions still awaiting an outcome, with an outcome skeleton that cannot be recorded unedited.
export async function pendingOutcomes(root, limit, options = {}) {
  const summary = await report(root, limit, options);
  const pending = [];
  for (const row of summary.rows.filter(r => r.decisionRecorded && !r.outcomeRecorded)) {
    const request = await readEvent(join(root, row.callId), 'request.json');
    const noul = Object.entries(request.input.questions).filter(([, q]) => q.type === 'noul').map(([id]) => id);
    pending.push({ callId: row.callId, requestedAt: row.requestedAt, scope: row.scope, objective: String(request.case.objective).slice(0, 200),
      selectedOption: row.selectedOption, recommendation: row.recommendation, adviceDisposition: row.adviceDisposition,
      outcomeTemplate: { actor: '', status: 'verified|failed|inconclusive', observation: '', evidenceRefs: [],
        labels: noul.map(questionId => ({ questionId, expected: 'true|false (verified status only; omit unless evidence decides it)', evidenceRef: '' })),
        inputQuality: '', outputQuality: '' } });
  }
  return { schemaVersion: 1, journalRootPresent: summary.journalRootPresent, sampledCalls: summary.sampledCalls, truncated: summary.truncated,
    decisionsWithoutOutcome: pending.length, adviceWithoutDecision: summary.followUp.adviceWithoutDecision, pending,
    usage: 'fill the template from real evidence, then: node .agents/refactor/jev-review.mjs outcome CALL_ID FILE (or - for stdin); leave it absent while validation is pending' };
}
export async function report(root, limit, { scanLimit = Math.max(DEFAULT_SCAN_LIMIT, limit), reviewPolicy = null, pricing = null } = {}) {
  ensure(Number.isSafeInteger(limit) && limit > 0 && Number.isSafeInteger(scanLimit) && scanLimit >= limit && scanLimit <= 1048576, 'JEV_REPORT_LIMIT');
  const listing = await entries(root, scanLimit);
  const requests = [];
  for (const id of listing.ids) {
    const request = await readEvent(join(root, id), 'request.json');
    requests.push({ id, request, time: instant(request.at) });
  }
  // Unknown request times rank after dated entries; their global chronological position is unknown.
  requests.sort((a, b) => (b.time ?? -Infinity) - (a.time ?? -Infinity) || a.id.localeCompare(b.id));
  const selected = requests.slice(0, limit);
  const rows = []; let brierSum = 0; let labels = 0;
  for (const { id, request, time } of selected) {
    const directory = join(root, id);
    const response = await optional(directory, 'response.json');
    const failure = await optional(directory, 'failure.json');
    const decision = await optional(directory, 'decision.json');
    const outcome = await optional(directory, 'outcome.json');
    let labeledNoulAnswers = 0;
    if (response) {
      for (const label of outcome?.status === 'verified' ? outcome.labels || [] : []) {
        const p = response.answers[label.questionId]?.noul;
        if (Number.isFinite(p) && typeof label.expected === 'boolean') { brierSum += (p - Number(label.expected)) ** 2; labels++; labeledNoulAnswers++; }
      }
    }
    const answer = response?.answers.next_action;
    // Thresholds in force at request time when recorded; otherwise the current config, labelled as such.
    const recordedPolicy = policyThresholds(request.versions?.reviewPolicy);
    const thresholds = recordedPolicy ?? policyThresholds(reviewPolicy);
    const status = response ? 'advice' : failure ? 'unavailable' : 'response-unknown';
    const selectedProbability = answer?.probabilities?.[answer.choice] ?? null;
    const sufficiency = response?.answers.sufficiency?.noul ?? null;
    const lineage = request.lineage && typeof request.lineage === 'object' ? request.lineage : 'unknown';
    rows.push({ callId: id, requestedAt: time === null ? null : request.at, scope: request.case.scope, revision: request.case.revision,
      status, model: response?.model ?? null, requestedModel: request.requestedModel ?? null, requestSha256: request.requestSha256 ?? null,
      failure: failure ? { error: typeof failure.error === 'string' ? failure.error : 'unknown', stage: failure.diagnostics?.stage ?? 'not-recorded' } : null,
      lineage, purpose: lineage === 'unknown' ? 'unknown' : lineage.purpose,
      adviceDisposition: adviceDisposition({ status, recommendation: answer?.choice ?? null, selectedProbability, sufficiency }, thresholds),
      thresholdSource: recordedPolicy ? 'request' : thresholds ? 'current-config' : 'none',
      usage: rowUsage(response, failure),
      latencyMs: response?.latencyMs ?? failure?.latencyMs ?? null, decisionRecorded: Boolean(decision), outcomeRecorded: Boolean(outcome),
      selectedOption: decision?.selectedOption ?? null, recommendation: answer?.choice ?? null,
      selectedProbability, confidence: answer?.confidence ?? null,
      sufficiency, labeledNoulAnswers,
      offeredChoiceIds: Object.keys(request.input.questions.next_action.criteria),
      abstentionProbabilities: Object.fromEntries(['none_of_the_above', 'insufficient_information', 'defer'].map(option => [option, answer?.probabilities?.[option] ?? null])),
      agreement: response && decision ? answer.choice === decision.selectedOption : null, outcome: outcome?.status ?? 'unobserved',
      inputQuality: outcome?.inputQuality ?? null, outputQuality: outcome?.outputQuality ?? null });
    const row = rows[rows.length - 1];
    row.estimatedUsd = response ? estimateUsd(response.model, row.usage, pricing) : null;
  }
  const times = rows.filter(r => r.latencyMs !== null).map(r => r.latencyMs).sort((a, b) => a - b);
  return { schemaVersion: 4, measuredAt: new Date().toISOString(), sampledCalls: rows.length,
    journalRootPresent: listing.rootPresent, scannedCalls: requests.length, scanLimit, scanTruncated: listing.truncated, undatedScannedCalls: count(requests, r => r.time === null),
    truncated: listing.truncated || requests.length > limit,
    selection: 'request-time descending among bounded scanned directories; undated requests last; scan truncation or undated requests leave global recency unknown',
    adviceDispositions: { ...Object.fromEntries(DISPOSITIONS.map(d => [d, count(rows, r => r.adviceDisposition === d)])),
      revisionPolicyExceeded: count(rows, r => r.lineage !== 'unknown' && r.lineage.exceedsRevisionPolicy === true),
      currentPolicy: policyThresholds(reviewPolicy), thresholdSources: Object.fromEntries(['request', 'current-config', 'none'].map(src => [src, count(rows, r => r.thresholdSource === src)])),
      adviceOnly: true, executionGate: false, approvalGate: false, basis: 'selected probability and sufficiency compared with >= to owner review criteria; confidence is reported separately' },
    lineage: lineageSummary(rows),
    abstentions: Object.fromEntries(['none_of_the_above', 'insufficient_information', 'defer'].map(option => [option, { offered: count(rows, r => r.offeredChoiceIds.includes(option)), selected: count(rows, r => r.recommendation === option) }])),
    usage: usageSummary(rows),
    latency: { samples: times.length, p50Ms: quantile(times, 0.5), p95Ms: quantile(times, 0.95), basis: 'recorded attempts, including failures with latency' },
    latencyByResult: latencyByResult(rows),
    cost: costSummary(rows, pricing),
    followUp: followUpSummary(rows),
    slices: { byServedModel: slice(rows, r => r.model ?? (r.status === 'unavailable' ? 'no-advice:failed' : 'no-advice:unknown'), pricing),
      byRequestedModel: slice(rows, r => r.requestedModel ?? 'unknown', pricing), byPurpose: slice(rows, r => r.purpose, pricing),
      calibrationPooling: 'never pool models or purposes for calibration claims' },
    quality: { labeledNoulAnswers: labels, labeledCalls: count(rows, r => r.labeledNoulAnswers > 0), brierScore: labels ? brierSum / labels : null,
      basis: 'operator-provided evidence-backed labels on verified outcomes; not independently verified or a representative benchmark', agreementIsCorrectness: false }, rows };
}
