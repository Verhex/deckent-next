// Development host only. Replays stored past cases against an evaluation provider config and writes a
// side-by-side report. Planning (the default) is read-only: no credential, no network, no writes.
// Execution makes paid calls and needs --execute, --out and a --max-calls budget covering every call.
import { readFile, writeFile, realpath, lstat } from 'node:fs/promises';
import { resolve, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readCredential, validateConfig, validateInput } from './jev.mjs';
import { ensure, instant, prepare, validateReviewConfig } from './jev-context.mjs';
import { entries, readEvent, privateDirectory } from './jev-journal.mjs';
import { consultPrepared } from './jev-review.mjs';
import { adviceDisposition, estimateUsd, knownCount, DEFAULT_SCAN_LIMIT } from './jev-report.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const quantile = (values, fraction) => values.length ? values[Math.ceil(values.length * fraction) - 1] : null;
async function optional(directory, name) {
  try { return await readEvent(directory, name); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
// Exact model IDs only (law 6): an alias could move between the planned and the executed comparison.
const exactModel = model => typeof model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(model) && !/-(?:latest|preview)$/.test(model);
const normalize = value => String(value).trim().toLocaleLowerCase('en-US').replace(/\s+/g, ' ');

function wireFor(model, input) { return { model, state: input.state, questions: input.questions }; }
function inputFor(request, mode, policy, requestAt) {
  if (mode === 'stored') return { input: validateInput(request.input), diagnostics: request.diagnostics ?? {} };
  return prepare(request.case, policy, requestAt);
}

// Deterministic selection: request-time descending; dated v2 cases with stored advice and a choice
// question; evaluation records excluded; exact resends and earlier revisions of the same decision
// (recorded caseId, else scope + objective) collapse to the latest. Explicit --call-ids override order.
export async function planComparison({ sourceRoot, candidate, baseline = null, policy, cases, callIds = null, inputMode = 'stored', scanLimit = DEFAULT_SCAN_LIMIT, now = new Date().toISOString() }) {
  validateConfig(candidate); ensure(exactModel(candidate.model), 'JEV_EVAL_ALIAS_MODEL');
  if (baseline) { validateConfig(baseline); ensure(exactModel(baseline.model), 'JEV_EVAL_ALIAS_MODEL'); }
  validateReviewConfig(policy);
  ensure(['stored', 'reprepare'].includes(inputMode), 'JEV_EVAL_USAGE');
  ensure(callIds ? Array.isArray(callIds) && callIds.length > 0 && cases === undefined : Number.isSafeInteger(cases) && cases > 0 && cases <= 200, 'JEV_EVAL_USAGE');
  const listing = await entries(sourceRoot, scanLimit);
  const skipped = []; const eligible = [];
  for (const id of listing.ids) {
    const directory = join(sourceRoot, id);
    const request = await readEvent(directory, 'request.json');
    const response = await optional(directory, 'response.json');
    const time = instant(request.at);
    const reason = !response ? 'no-stored-advice' : time === null ? 'undated' : request.case?.schemaVersion !== 2 ? 'legacy-case-schema'
      : !object(request.input?.questions?.next_action) ? 'no-choice-question' : request.lineage?.purpose === 'evaluation' ? 'evaluation-record' : null;
    if (reason) { skipped.push({ callId: id, reason }); continue; }
    eligible.push({ id, request, response, time });
  }
  eligible.sort((a, b) => b.time - a.time || a.id.localeCompare(b.id));
  let ordered;
  if (callIds) {
    ordered = callIds.map(id => { const found = eligible.find(e => e.id === id); ensure(found, 'JEV_EVAL_CASE_NOT_ELIGIBLE'); return found; });
  } else {
    const seenDigest = new Set(); const seenDecision = new Set(); ordered = [];
    for (const e of eligible) {
      const decision = typeof e.request.lineage?.caseId === 'string' ? `case:${e.request.lineage.caseId}` : `objective:${normalize(e.request.case.scope)}|${normalize(e.request.case.objective)}`;
      if (seenDigest.has(e.request.requestSha256)) { skipped.push({ callId: e.id, reason: 'duplicate-request-digest' }); continue; }
      if (seenDecision.has(decision)) { skipped.push({ callId: e.id, reason: 'earlier-revision-of-selected-decision' }); continue; }
      seenDigest.add(e.request.requestSha256); seenDecision.add(decision); ordered.push(e);
    }
  }
  const selected = [];
  for (const e of ordered) {
    if (!callIds && selected.length === cases) break;
    let prepared;
    try { prepared = inputFor(e.request, inputMode, policy, now); } catch (error) {
      if (callIds) throw error;
      skipped.push({ callId: e.id, reason: `not-preparable:${/^JEV_[A-Z0-9_]+$/.test(error.message) ? error.message : 'JEV_CASE'}` }); continue;
    }
    const fitsAll = input => [candidate, baseline].filter(Boolean).every(c => Buffer.byteLength(JSON.stringify(wireFor(c.model, input))) <= c.maxRequestBytes);
    // As in consult: the non-gating shadow is dropped (recorded) rather than making a case unaskable.
    if (!fitsAll(prepared.input) && prepared.diagnostics?.shadow?.included) prepared = prepare(e.request.case, policy, now, { shadow: false, shadowOmittedReason: 'request-size' });
    const fits = fitsAll(prepared.input);
    if (!fits) { ensure(!callIds, 'JEV_REQUEST_TOO_LARGE'); skipped.push({ callId: e.id, reason: 'request-too-large-for-config' }); continue; }
    selected.push({ ...e, prepared });
  }
  const tokens = selected.map(e => e.response.usage?.input_tokens);
  const knownTokens = tokens.filter(knownCount).reduce((sum, n) => sum + n, 0);
  const estimate = config => {
    const priced = selected.map(e => estimateUsd(config.model, { inputTokens: e.response.usage?.input_tokens, outputTokens: 'unknown' }, policy.pricing));
    return { model: config.model, calls: selected.length, estimatedUsd: priced.filter(v => v !== null).reduce((sum, v) => sum + v, 0), costUnknownCalls: priced.filter(v => v === null).length,
      price: policy.pricing?.models?.[config.model] ?? null };
  };
  const candidateEstimate = estimate(candidate); const baselineEstimate = baseline ? estimate(baseline) : null;
  const plan = { schemaVersion: 1, network: false, plannedAt: now, inputMode,
    candidate: { model: candidate.model, configSha256: digest(candidate) }, baseline: baseline ? { model: baseline.model, configSha256: digest(baseline) } : { source: 'stored-response' },
    reviewConfigSha256: digest(policy),
    selection: { requested: callIds ? callIds.length : cases, explicit: Boolean(callIds), scanned: listing.ids.length, scanTruncated: listing.truncated, journalRootPresent: listing.rootPresent,
      eligible: eligible.length, selected: selected.length, skipped,
      criteria: 'request-time descending; dated schemaVersion 2 cases with stored advice; evaluation records excluded; one case per exact request digest and per decision (recorded caseId, else scope + objective), latest kept' },
    cases: selected.map(e => ({ callId: e.id, requestedAt: e.request.at, scope: e.request.case.scope, requestSha256: e.request.requestSha256,
      baselineModel: e.response.model, baselineInputTokens: knownCount(e.response.usage?.input_tokens) ? e.response.usage.input_tokens : 'unknown' })),
    calls: { candidate: selected.length, baseline: baseline ? selected.length : 0, total: selected.length * (baseline ? 2 : 1), concurrency: 1, retries: 0 },
    estimate: { knownBaselineInputTokens: knownTokens, unknownTokenCases: tokens.filter(t => !knownCount(t)).length, candidate: candidateEstimate, baseline: baselineEstimate,
      totalUsd: candidateEstimate.estimatedUsd + (baselineEstimate?.estimatedUsd ?? 0),
      basis: 'stored baseline input tokens x dated list price from review config; the replayed model may tokenize differently; not an invoice' } };
  // Prepared inputs stay in memory for execution and never reach printed or written plans.
  Object.defineProperty(plan, 'selected', { value: selected, enumerable: false });
  return plan;
}

function side(result, policy) {
  if (!result) return null;
  const answer = result.answers?.next_action;
  const status = result.status ?? (result.answers ? 'advice' : 'unavailable');
  const selectedProbability = answer?.probabilities?.[answer.choice] ?? null; const sufficiency = result.answers?.sufficiency?.noul ?? null;
  const usage = { inputTokens: knownCount(result.usage?.input_tokens) ? result.usage.input_tokens : 'unknown', outputTokens: knownCount(result.usage?.output_tokens) ? result.usage.output_tokens : 'unknown' };
  return { status, callId: result.callId ?? null, model: result.model ?? null, choice: answer?.choice ?? null, selectedProbability, confidence: answer?.confidence ?? null, sufficiency,
    sufficiencyShadow: result.answers?.sufficiency_shadow?.noul ?? null,
    disposition: adviceDisposition({ status, recommendation: answer?.choice ?? null, selectedProbability, sufficiency }, policy.reviewPolicy), usage,
    estimatedUsd: status === 'advice' ? estimateUsd(result.model, usage, policy.pricing) : null, latencyMs: result.latencyMs ?? null,
    error: result.error ?? null, stage: result.stage ?? null,
    noul: Object.fromEntries(Object.entries(result.answers ?? {}).filter(([, a]) => a.type === 'noul').map(([id, a]) => [id, a.noul])) };
}
function compare(a, b) {
  if (a?.status !== 'advice' || b?.status !== 'advice') return { comparable: false };
  const ids = Object.keys(a.noul).filter(id => Object.hasOwn(b.noul, id));
  return { comparable: true, choiceChanged: a.choice !== b.choice, selectedProbability: b.selectedProbability - a.selectedProbability,
    sufficiency: b.sufficiency - a.sufficiency, dispositionChanged: a.disposition !== b.disposition,
    maxNoulDelta: ids.length ? Math.max(...ids.map(id => Math.abs(b.noul[id] - a.noul[id]))) : null };
}
function sideSummary(sides) {
  const advice = sides.filter(s => s?.status === 'advice');
  const lat = advice.map(s => s.latencyMs).filter(Number.isFinite).sort((x, y) => x - y);
  const models = {}; for (const s of advice) models[s.model] = (models[s.model] ?? 0) + 1;
  return { attempts: sides.filter(Boolean).length, advice: advice.length, unavailable: sides.filter(s => s && s.status !== 'advice').length, servedModels: models,
    knownInputTokens: advice.filter(s => knownCount(s.usage.inputTokens)).reduce((sum, s) => sum + s.usage.inputTokens, 0),
    unknownInputTokens: sides.filter(s => s && !knownCount(s.usage.inputTokens)).length,
    estimatedUsd: advice.filter(s => s.estimatedUsd !== null).reduce((sum, s) => sum + s.estimatedUsd, 0), costUnknown: sides.filter(s => s && s.estimatedUsd === null).length,
    successLatency: { samples: lat.length, p50Ms: quantile(lat, 0.5), p95Ms: quantile(lat, 0.95) },
    failures: Object.fromEntries([...new Set(sides.filter(s => s && s.status !== 'advice').map(s => s.error))].map(e => [e, sides.filter(s => s?.error === e).length])) };
}

export async function runComparison(options, { key, transport, out, maxCalls }) {
  const plan = await planComparison(options);
  ensure(Number.isSafeInteger(maxCalls) && maxCalls >= plan.calls.total, 'JEV_EVAL_CALL_BUDGET');
  const outDir = resolve(out); const source = resolve(options.sourceRoot);
  ensure(outDir !== source && !outDir.startsWith(source + sep) && !source.startsWith(outDir + sep), 'JEV_EVAL_OUT');
  // A fresh output directory: an evaluation never appends to or overwrites a previous run.
  ensure(await lstat(outDir).then(() => false, e => { if (e.code === 'ENOENT') return true; throw e; }), 'JEV_EVAL_OUT_EXISTS');
  await privateDirectory(outDir); const journal = join(outDir, 'journal');
  const { selected } = plan; const publicPlan = { ...plan };
  await writeFile(join(outDir, 'plan.json'), JSON.stringify(publicPlan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const rows = [];
  for (const e of selected) {
    const meta = { relation: 'evaluation-replay', purpose: 'evaluation', replayOf: { callId: e.id, requestSha256: e.request.requestSha256, inputMode: plan.inputMode } };
    const call = config => consultPrepared(config, options.policy, { authoredCase: e.request.case, prepared: e.prepared, requestAt: new Date().toISOString(),
      inputSource: plan.inputMode === 'stored' ? 'replayed-stored-input' : 'prepared' }, journal, key, transport, meta);
    const candidate = side(await call(options.candidate), options.policy);
    const baseline = options.baseline ? side(await call(options.baseline), options.policy) : side({ ...e.response, status: 'advice', callId: e.id }, options.policy);
    const charter = { baselineSha256: e.request.input.state?.northStar?.sha256 ?? 'unknown', candidateSha256: e.prepared.input.state?.northStar?.sha256 ?? 'unknown' };
    const templates = { baseline: e.request.diagnostics?.templates?.sha256 ?? 'unknown', candidate: e.prepared.diagnostics?.templates?.sha256 ?? 'unknown' };
    rows.push({ callId: e.id, requestedAt: e.request.at, scope: e.request.case.scope, objective: String(e.request.case.objective).slice(0, 160),
      contextChanged: charter.baselineSha256 !== charter.candidateSha256 || templates.baseline !== templates.candidate || (options.baseline ? false : plan.inputMode !== 'stored'),
      charter, templates, baseline, candidate, delta: compare(baseline, candidate) });
  }
  const comparable = rows.filter(r => r.delta.comparable);
  const transitions = {}; for (const r of comparable) { const k = `${r.baseline.disposition} -> ${r.candidate.disposition}`; transitions[k] = (transitions[k] ?? 0) + 1; }
  const mean = field => comparable.length ? comparable.reduce((sum, r) => sum + r.delta[field], 0) / comparable.length : null;
  const report = { schemaVersion: 1, completedAt: new Date().toISOString(), plan: publicPlan, rows,
    summary: { cases: rows.length, comparable: comparable.length, sameChoice: comparable.filter(r => !r.delta.choiceChanged).length, differentChoice: comparable.filter(r => r.delta.choiceChanged).length,
      meanDelta: { selectedProbability: mean('selectedProbability'), sufficiency: mean('sufficiency') }, dispositionTransitions: transitions,
      contextChangedCases: rows.filter(r => r.contextChanged).length,
      baseline: sideSummary(rows.map(r => r.baseline)), candidate: sideSummary(rows.map(r => r.candidate)),
      thresholds: options.policy.reviewPolicy ?? null },
    limits: ['agreement is not correctness; no labels are created', 'a stored baseline ran earlier, possibly on a different alias target and day',
      'contextChanged cases compare context as well as model', 'dispositions are advice classifications, not approval or promotion', 'estimates are list-price scenarios, not invoices'] };
  await writeFile(join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await writeFile(join(outDir, 'report.md'), markdown(report), { flag: 'wx', mode: 0o600 });
  return report;
}

const fmt = v => v === null || v === undefined ? '-' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(3)) : String(v);
const cell = v => fmt(v).replace(/\|/g, '/').replace(/\s+/g, ' ');
function markdown(r) {
  const s = r.summary;
  const lines = [`# Jev evaluation comparison`, '', `Candidate ${cell(r.plan.candidate.model)}; baseline ${cell(r.plan.baseline.model ?? r.plan.baseline.source)}; input ${r.plan.inputMode}; ${s.cases} cases, ${s.comparable} comparable.`,
    `Same choice ${s.sameChoice}, different ${s.differentChoice}; mean delta selected ${fmt(s.meanDelta.selectedProbability)}, sufficiency ${fmt(s.meanDelta.sufficiency)}; context changed in ${s.contextChangedCases}.`,
    `Estimated cost (list price, not invoice): candidate $${s.candidate.estimatedUsd.toFixed(6)}, baseline $${s.baseline.estimatedUsd.toFixed(6)}. Success p50/p95 ms: candidate ${fmt(s.candidate.successLatency.p50Ms)}/${fmt(s.candidate.successLatency.p95Ms)}, baseline ${fmt(s.baseline.successLatency.p50Ms)}/${fmt(s.baseline.successLatency.p95Ms)}.`, '',
    '| callId | scope | baseline choice | p | suff | disp | candidate choice | p | suff | disp | context changed |', '|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const row of r.rows) lines.push(`| ${row.callId} | ${cell(row.scope)} | ${cell(row.baseline?.choice ?? row.baseline?.error)} | ${fmt(row.baseline?.selectedProbability)} | ${fmt(row.baseline?.sufficiency)} | ${cell(row.baseline?.disposition)} | ${cell(row.candidate?.choice ?? row.candidate?.error)} | ${fmt(row.candidate?.selectedProbability)} | ${fmt(row.candidate?.sufficiency)} | ${cell(row.candidate?.disposition)} | ${row.contextChanged} |`);
  lines.push('', ...r.limits.map(l => `- ${l}`), '');
  return lines.join('\n');
}

const FLAGS = { '--config': 'config', '--baseline-config': 'baselineConfig', '--review-config': 'reviewConfig', '--source-root': 'sourceRoot', '--cases': 'cases',
  '--call-ids': 'callIds', '--input': 'input', '--out': 'out', '--max-calls': 'maxCalls' };
export function parseArgs(args) {
  const opts = { execute: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--execute') { ensure(!opts.execute, 'JEV_EVAL_USAGE'); opts.execute = true; continue; }
    const field = FLAGS[args[i]];
    ensure(field && !Object.hasOwn(opts, field) && i + 1 < args.length, 'JEV_EVAL_USAGE');
    opts[field] = args[++i];
  }
  ensure(opts.config && (opts.cases === undefined) !== (opts.callIds === undefined), 'JEV_EVAL_USAGE');
  ensure(opts.cases === undefined || /^[1-9][0-9]{0,2}$/.test(opts.cases), 'JEV_EVAL_USAGE');
  ensure(opts.maxCalls === undefined || /^[1-9][0-9]{0,3}$/.test(opts.maxCalls), 'JEV_EVAL_USAGE');
  ensure(opts.execute ? opts.out && opts.maxCalls : !opts.out && !opts.maxCalls, 'JEV_EVAL_USAGE');
  return opts;
}
async function main(argv) {
  const opts = parseArgs(argv);
  const json = async path => JSON.parse(await readFile(path, 'utf8'));
  const reviewPath = opts.reviewConfig || process.env.DECKENT_JEV_REVIEW_CONFIG || join(here, 'jev.review.config.json');
  const policy = validateReviewConfig(await json(reviewPath));
  const options = { candidate: validateConfig(await json(opts.config)), baseline: opts.baselineConfig ? validateConfig(await json(opts.baselineConfig)) : null, policy,
    sourceRoot: opts.sourceRoot ? resolve(opts.sourceRoot) : resolve(dirname(resolve(reviewPath)), policy.journalRoot),
    cases: opts.cases === undefined ? undefined : Number(opts.cases), callIds: opts.callIds ? opts.callIds.split(',') : null, inputMode: opts.input ?? 'stored',
    scanLimit: policy.reportScanLimit ?? Math.max(DEFAULT_SCAN_LIMIT, policy.reportLimit) };
  if (!opts.execute) return planComparison(options);
  // Paid path: the credential is read only here, after the plan validates.
  const key = await readCredential(options.candidate);
  const report = await runComparison(options, { key, out: opts.out, maxCalls: Number(opts.maxCalls) });
  return { out: resolve(opts.out), summary: report.summary };
}
if (process.argv[1] && await realpath(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result, null, 2) + '\n'))
    .catch(e => { process.stderr.write(JSON.stringify({ error: /^JEV_[A-Z0-9_]+$/.test(e.message) ? e.message : 'JEV_EVAL_FAILED', advisoryOnly: true }) + '\n'); process.exitCode = 1; });
}
