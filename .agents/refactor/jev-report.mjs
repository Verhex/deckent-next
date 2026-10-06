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
export async function report(root, limit, { scanLimit = Math.max(DEFAULT_SCAN_LIMIT, limit) } = {}) {
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
  const rows = []; let inputTokens = 0; let outputTokens = 0; let brierSum = 0; let labels = 0;
  for (const { id, request, time } of selected) {
    const directory = join(root, id);
    const response = await optional(directory, 'response.json');
    const failure = await optional(directory, 'failure.json');
    const decision = await optional(directory, 'decision.json');
    const outcome = await optional(directory, 'outcome.json');
    let labeledNoulAnswers = 0;
    if (response) {
      inputTokens += response.usage.input_tokens; outputTokens += response.usage.output_tokens;
      for (const label of outcome?.status === 'verified' ? outcome.labels || [] : []) {
        const p = response.answers[label.questionId]?.noul;
        if (Number.isFinite(p) && typeof label.expected === 'boolean') { brierSum += (p - Number(label.expected)) ** 2; labels++; labeledNoulAnswers++; }
      }
    }
    const answer = response?.answers.next_action;
    rows.push({ callId: id, requestedAt: time === null ? null : request.at, scope: request.case.scope, revision: request.case.revision,
      status: response ? 'advice' : failure ? 'unavailable' : 'response-unknown', model: response?.model ?? null,
      latencyMs: response?.latencyMs ?? failure?.latencyMs ?? null, decisionRecorded: Boolean(decision), outcomeRecorded: Boolean(outcome),
      selectedOption: decision?.selectedOption ?? null, recommendation: answer?.choice ?? null,
      selectedProbability: answer?.probabilities?.[answer.choice] ?? null, confidence: answer?.confidence ?? null,
      sufficiency: response?.answers.sufficiency?.noul ?? null, labeledNoulAnswers,
      offeredChoiceIds: Object.keys(request.input.questions.next_action.criteria),
      abstentionProbabilities: Object.fromEntries(['none_of_the_above', 'insufficient_information', 'defer'].map(option => [option, answer?.probabilities?.[option] ?? null])),
      agreement: response && decision ? answer.choice === decision.selectedOption : null, outcome: outcome?.status ?? 'unobserved',
      inputQuality: outcome?.inputQuality ?? null, outputQuality: outcome?.outputQuality ?? null });
  }
  const times = rows.filter(r => r.latencyMs !== null).map(r => r.latencyMs).sort((a, b) => a - b);
  return { schemaVersion: 3, measuredAt: new Date().toISOString(), sampledCalls: rows.length,
    scannedCalls: requests.length, scanLimit, scanTruncated: listing.truncated, undatedScannedCalls: count(requests, r => r.time === null),
    truncated: listing.truncated || requests.length > limit,
    selection: 'request-time descending among bounded scanned directories; undated requests last; scan truncation or undated requests leave global recency unknown',
    abstentions: Object.fromEntries(['none_of_the_above', 'insufficient_information', 'defer'].map(option => [option, { offered: count(rows, r => r.offeredChoiceIds.includes(option)), selected: count(rows, r => r.recommendation === option) }])),
    usage: { inputTokens, outputTokens, excludesFailedAndUnrecordedUsage: true },
    latency: { samples: times.length, p50Ms: quantile(times, 0.5), p95Ms: quantile(times, 0.95), basis: 'recorded attempts, including failures with latency' },
    followUp: { adviceCalls: count(rows, r => r.status === 'advice'), decisionsRecorded: count(rows, r => r.decisionRecorded),
      adviceWithoutDecision: count(rows, r => r.status === 'advice' && !r.decisionRecorded),
      outcomesRecorded: count(rows, r => r.outcomeRecorded), decisionsWithoutOutcome: count(rows, r => r.decisionRecorded && !r.outcomeRecorded),
      callsWithoutOutcome: count(rows, r => !r.outcomeRecorded),
      outcomeCounts: Object.fromEntries(['verified', 'failed', 'inconclusive', 'unobserved'].map(status => [status, count(rows, r => r.outcome === status)])),
      recordingGapIsFailure: false, pendingOrOmittedIsUnknown: true },
    quality: { labeledNoulAnswers: labels, labeledCalls: count(rows, r => r.labeledNoulAnswers > 0), brierScore: labels ? brierSum / labels : null,
      basis: 'operator-provided evidence-backed labels on verified outcomes; not independently verified or a representative benchmark', agreementIsCorrectness: false }, rows };
}
