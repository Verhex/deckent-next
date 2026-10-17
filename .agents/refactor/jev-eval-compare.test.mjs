import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, readdir, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { consult } from './jev-review.mjs';
import { prepare } from './jev-context.mjs';
import { callId, writeEvent, readEvent } from './jev-journal.mjs';
import { planComparison, runComparison, parseArgs } from './jev-eval-compare.mjs';

const reason = process.platform === 'win32' && 'JEV_JOURNAL_UNSUPPORTED: private UID/mode/no-follow journal custody has no Windows implementation';
const journalTest = (name, fn) => test(name, { skip: reason }, fn);
const config = JSON.parse(await readFile(new URL('./jev.config.json', import.meta.url), 'utf8'));
const evalConfig = JSON.parse(await readFile(new URL('./jev.eval.config.json', import.meta.url), 'utf8'));
const policy = JSON.parse(await readFile(new URL('./jev.review.config.json', import.meta.url), 'utf8'));
const key = 'local-eval-test-secret-never-live';
const fixture = (objective = 'Choose next validation action.', revision = 'fixture-v1') => ({ schemaVersion: 2, process: { stage: 'validation', currentState: 'Failure unexplained', acceptedDecisions: ['Do not accept without proof'], nextStep: 'Investigate failure', reopenReason: null }, objective, scope: 'host-test', revision, evidence: [{ id: 'test', source: 'fixture', observedAt: '2026-09-19T00:00:00Z', observation: '[retained-run] A test failed without a known cause.' }], constraints: ['Do not claim an unexplained failure fixed.'], unknowns: ['Failure cause'], options: [{ id: 'investigate', action: 'Inspect failure evidence', tradeoffs: ['Gain: reliable acceptance; loss: investigation time'], northStarImpact: 'Preserves evidence-based reliability', evidenceIds: ['test'] }, { id: 'accept', action: 'Accept without investigation', tradeoffs: ['Gain: immediate progress; loss: unresolved failure risk'], northStarImpact: 'Compromises reliable acceptance', evidenceIds: ['test'] }], checks: [{ id: 'supported', instructions: 'Is acceptance supported?', evidenceIds: ['test'] }] });
const answering = (model, selected = 0.9, sufficiency = 0.7, inputTokens = 1000) => async (_url, options) => {
  const { questions, model: requested } = JSON.parse(options.body);
  return Response.json({ model: model ?? requested, answers: Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, q.type === 'noul' ? { type: 'noul', noul: id === 'sufficiency' ? sufficiency : 0.3 }
    : { type: 'choice', choice: 'investigate', confidence: 0.6, probabilities: Object.fromEntries(Object.keys(q.criteria).map(o => [o, o === 'investigate' ? selected : (1 - selected) / 3])) }])),
  usage: { input_tokens: inputTokens, output_tokens: 0 } });
};
async function sandbox(fn) {
  const root = await mkdtemp(join(tmpdir(), 'jev-eval-test-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function snapshot(root) {
  const out = {};
  for (const id of await readdir(root)) {
    out[id] = { mode: (await stat(join(root, id))).mode };
    for (const name of await readdir(join(root, id))) out[`${id}/${name}`] = createHash('sha256').update(await readFile(join(root, id, name))).digest('hex');
  }
  return out;
}
// Source journal: 3 distinct decisions (one with a context revision), one exact resend, one failure,
// one evaluation record, one legacy-schema case and one pending request.
async function sourceJournal(root) {
  const src = join(root, 'source');
  const old = await consult({ ...config, model: 'jev-1.13.0' }, policy, fixture('Decision A'), src, key, answering('jev-1.13.0', 0.9, 0.6, 3000));
  const a2 = await consult({ ...config, model: 'jev-1.13.0' }, policy, fixture('Decision A', 'fixture-v2'), src, key, answering('jev-1.13.0', 0.95, 0.72, 3200), { relation: 'context-revision', parentCallId: old.callId, reason: 'Added excerpt.' });
  const b = await consult({ ...config, model: 'jev-1.13.0' }, policy, fixture('Decision B'), src, key, answering('jev-1.13.0', 0.8, 0.8, 5000));
  const bResend = await consult({ ...config, model: 'jev-1.13.0' }, policy, fixture('Decision B'), src, key, answering('jev-1.13.0', 0.81, 0.8, 5000));
  await consult({ ...config, model: 'jev-1.13.0' }, policy, fixture('Decision C'), src, key, async () => new Response('', { status: 503 }));
  const d = await consult({ ...config, model: 'jev-1.13.0' }, policy, fixture('Decision D'), src, key, answering('jev-1.13.0', 0.99, 0.9, null));
  await consult({ ...config, model: 'jev-1.13.0' }, policy, fixture('Decision E'), src, key, answering('jev-1.13.0'), { purpose: 'evaluation' });
  const legacy = callId();
  await writeEvent(join(src, legacy), 'request.json', { at: new Date().toISOString(), case: { ...fixture('Legacy'), schemaVersion: 1 }, input: prepare(fixture('Legacy'), policy).input, requestSha256: 'b'.repeat(64) }, key);
  await writeEvent(join(src, legacy), 'response.json', { model: 'jev-1.13.0', answers: {}, usage: { input_tokens: 1, output_tokens: 0 } }, key);
  const pending = callId();
  await writeEvent(join(src, pending), 'request.json', { at: new Date().toISOString(), case: fixture('Pending'), input: prepare(fixture('Pending'), policy).input, requestSha256: 'c'.repeat(64) }, key);
  return { src, old, a2, b, bResend, d, legacy, pending };
}

test('the evaluation config pins jev-1.14.0 exactly while the default config is unchanged', () => {
  assert.equal(evalConfig.model, 'jev-1.14.0');
  assert.equal(config.model, 'jev-latest');
  assert.deepEqual({ ...evalConfig, model: null }, { ...config, model: null });
  const baselineConfig = JSON.parse(readFileSync(new URL('./jev.eval.baseline.config.json', import.meta.url), 'utf8'));
  assert.equal(baselineConfig.model, 'jev-1.13.0'); assert.deepEqual({ ...baselineConfig, model: null }, { ...config, model: null });
});

journalTest('plan selects distinct recent decisions read-only, estimates cost from stored tokens and makes no call', async () => sandbox(async root => {
  const j = await sourceJournal(root);
  const before = await snapshot(j.src);
  const plan = await planComparison({ sourceRoot: j.src, candidate: evalConfig, policy, cases: 10 });
  assert.equal(plan.network, false);
  const selected = plan.cases.map(c => c.callId);
  // Latest first: D, B-resend (B collapses to it), A revision 2 (A collapses to it).
  assert.deepEqual(selected, [j.d.callId, j.bResend.callId, j.a2.callId]);
  const reasons = Object.fromEntries(plan.selection.skipped.map(s => [s.callId, s.reason]));
  assert.equal(reasons[j.b.callId], 'duplicate-request-digest');
  assert.equal(reasons[j.old.callId], 'earlier-revision-of-selected-decision');
  assert.equal(reasons[j.legacy], 'legacy-case-schema'); assert.equal(reasons[j.pending], 'no-stored-advice');
  assert.ok(plan.selection.skipped.some(s => s.reason === 'evaluation-record'));
  assert.equal(plan.selection.skipped.filter(s => s.reason === 'no-stored-advice').length, 2); // pending + failure
  assert.deepEqual(plan.calls, { candidate: 3, baseline: 0, total: 3, concurrency: 1, retries: 0 });
  assert.equal(plan.estimate.knownBaselineInputTokens, 8200); assert.equal(plan.estimate.unknownTokenCases, 1);
  assert.ok(Math.abs(plan.estimate.candidate.estimatedUsd - 8200 * 0.042 / 1e6) < 1e-15);
  assert.equal(plan.estimate.candidate.costUnknownCalls, 1);
  assert.deepEqual(await snapshot(j.src), before);
  const limited = await planComparison({ sourceRoot: j.src, candidate: evalConfig, baseline: { ...config, model: 'jev-1.13.0' }, policy, cases: 2 });
  assert.deepEqual(limited.cases.map(c => c.callId), [j.d.callId, j.bResend.callId]);
  assert.deepEqual(limited.calls, { candidate: 2, baseline: 2, total: 4, concurrency: 1, retries: 0 });
  const explicit = await planComparison({ sourceRoot: j.src, candidate: evalConfig, policy, callIds: [j.old.callId] });
  assert.deepEqual(explicit.cases.map(c => c.callId), [j.old.callId]);
  await assert.rejects(planComparison({ sourceRoot: j.src, candidate: evalConfig, policy, callIds: [j.legacy] }), /JEV_EVAL_CASE_NOT_ELIGIBLE/);
  for (const model of ['jev-latest', 'jev-preview']) await assert.rejects(planComparison({ sourceRoot: j.src, candidate: { ...evalConfig, model }, policy, cases: 1 }), /JEV_EVAL_ALIAS_MODEL/);
  // A missing source journal plans nothing and creates nothing.
  const empty = await planComparison({ sourceRoot: join(root, 'absent'), candidate: evalConfig, policy, cases: 5 });
  assert.equal(empty.selection.journalRootPresent, false); assert.equal(empty.calls.total, 0);
  assert.deepEqual((await readdir(root)).sort(), ['source']);
}));

journalTest('execution replays exactly the planned stored requests once each into a separate journal and writes a side-by-side report', async () => sandbox(async root => {
  const j = await sourceJournal(root);
  const before = await snapshot(j.src);
  const sent = [];
  const transport = async (url, options) => { sent.push(JSON.parse(options.body)); return answering(undefined, 0.97, 0.75, 1200)(url, options); };
  const out = join(root, 'out');
  const options = { sourceRoot: j.src, candidate: evalConfig, policy, cases: 2 };
  await assert.rejects(runComparison(options, { key, transport, out, maxCalls: 1 }), /JEV_EVAL_CALL_BUDGET/);
  await assert.rejects(runComparison(options, { key, transport, out: join(j.src, 'nested'), maxCalls: 2 }), /JEV_EVAL_OUT/);
  assert.equal(sent.length, 0);
  const report = await runComparison(options, { key, transport, out, maxCalls: 2 });
  assert.equal(sent.length, 2);
  // Stored mode: identical state and questions, only the model differs.
  const storedA = await readEvent(join(j.src, j.d.callId), 'request.json');
  assert.deepEqual(sent[0].state, storedA.input.state); assert.deepEqual(sent[0].questions, storedA.input.questions); assert.equal(sent[0].model, 'jev-1.14.0');
  assert.deepEqual(await snapshot(j.src), before);
  assert.deepEqual((await readdir(out)).sort(), ['journal', 'plan.json', 'report.json', 'report.md']);
  const evalIds = await readdir(join(out, 'journal'));
  assert.equal(evalIds.length, 2);
  const evalRequest = await readEvent(join(out, 'journal', evalIds[0]), 'request.json');
  assert.equal(evalRequest.lineage.relation, 'evaluation-replay'); assert.equal(evalRequest.lineage.purpose, 'evaluation');
  assert.equal(evalRequest.versions.inputSource, 'replayed-stored-input');
  assert.ok([j.d.callId, j.bResend.callId].includes(evalRequest.lineage.replayOf.callId));
  const row = report.rows.find(r => r.callId === j.bResend.callId);
  assert.equal(row.baseline.model, 'jev-1.13.0'); assert.equal(row.candidate.model, 'jev-1.14.0');
  assert.equal(row.baseline.disposition, 'below-choice'); assert.equal(row.candidate.disposition, 'thresholds-met');
  assert.equal(row.contextChanged, false); assert.equal(row.delta.choiceChanged, false);
  assert.ok(Math.abs(row.delta.selectedProbability - 0.16) < 1e-9);
  assert.equal(report.summary.dispositionTransitions['below-choice -> thresholds-met'], 1);
  assert.equal(report.summary.candidate.servedModels['jev-1.14.0'], 2);
  assert.ok(Math.abs(report.summary.candidate.estimatedUsd - 2400 * 0.042 / 1e6) < 1e-15);
  assert.match(await readFile(join(out, 'report.md'), 'utf8'), /\| callId \| scope \|/);
  assert.ok(!(await readFile(join(out, 'report.json'), 'utf8')).includes(key));
  // A second run never reuses or overwrites an output directory.
  await assert.rejects(runComparison(options, { key, transport, out, maxCalls: 2 }), /JEV_EVAL_OUT_EXISTS/);
  assert.equal(sent.length, 2);
}));

journalTest('a live baseline doubles the calls and failures stay failures; reprepare mode flags changed context', async () => sandbox(async root => {
  const j = await sourceJournal(root);
  let calls = 0;
  const transport = async (url, options) => { calls++; const { model } = JSON.parse(options.body); return model === 'jev-1.14.0' ? new Response('', { status: 529 }) : answering(undefined)(url, options); };
  const report = await runComparison({ sourceRoot: j.src, candidate: evalConfig, baseline: { ...config, model: 'jev-1.13.0' }, policy, cases: 1 }, { key, transport, out: join(root, 'out'), maxCalls: 2 });
  assert.equal(calls, 2);
  assert.equal(report.rows[0].candidate.status, 'unavailable'); assert.equal(report.rows[0].candidate.error, 'JEV_HTTP_529');
  assert.equal(report.rows[0].delta.comparable, false); assert.deepEqual(report.summary.candidate.failures, { JEV_HTTP_529: 1 });
  const legacyPolicy = structuredClone(policy); legacyPolicy.templateVersion = 'other'; legacyPolicy.templates.sufficiencyRubric += ' Changed.';
  const re = await runComparison({ sourceRoot: j.src, candidate: evalConfig, policy: legacyPolicy, cases: 1, inputMode: 'reprepare' }, { key, transport: answering(undefined), out: join(root, 'out2'), maxCalls: 1 });
  assert.equal(re.rows[0].contextChanged, true); assert.notEqual(re.rows[0].templates.baseline, re.rows[0].templates.candidate);
}));

test('CLI arguments: planning is the default; execution requires an output directory and a call budget', () => {
  assert.deepEqual(parseArgs(['--config', 'c.json', '--cases', '20']), { execute: false, config: 'c.json', cases: '20' });
  assert.equal(parseArgs(['--config', 'c', '--cases', '5', '--execute', '--out', 'o', '--max-calls', '5']).execute, true);
  for (const args of [['--cases', '5'], ['--config', 'c'], ['--config', 'c', '--cases', '5', '--call-ids', 'x'], ['--config', 'c', '--cases', '0'],
    ['--config', 'c', '--cases', '5', '--execute'], ['--config', 'c', '--cases', '5', '--execute', '--out', 'o'], ['--config', 'c', '--cases', '5', '--out', 'o'],
    ['--config', 'c', '--cases', '5', '--unknown', 'x']]) assert.throws(() => parseArgs(args), /JEV_EVAL_USAGE/);
});

journalTest('CLI planning reads no credential and calls no network', async () => sandbox(async root => {
  const j = await sourceJournal(root);
  const before = await snapshot(j.src);
  // No credential is configured or present in the environment; planning must still succeed.
  const provider = { ...evalConfig, credentialEnv: 'JEV_EVAL_TEST_ABSENT', credentialFileEnv: 'JEV_EVAL_TEST_ABSENT_FILE' }; delete provider.credentialFile;
  await writeFile(join(root, 'eval.json'), JSON.stringify(provider));
  const output = execFileSync(process.execPath, [new URL('./jev-eval-compare.mjs', import.meta.url).pathname, '--config', join(root, 'eval.json'), '--cases', '2', '--source-root', j.src],
    { env: { PATH: process.env.PATH }, encoding: 'utf8' });
  const plan = JSON.parse(output);
  assert.equal(plan.network, false); assert.equal(plan.calls.total, 2); assert.equal(plan.selected, undefined);
  assert.deepEqual(await snapshot(j.src), before);
}));
