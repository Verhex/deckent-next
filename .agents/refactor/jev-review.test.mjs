import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, symlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepare } from './jev-context.mjs';
import { consult, followup, report } from './jev-review.mjs';
import { readEvent, writeEvent, callId, entries } from './jev-journal.mjs';

function journalTest(name, fn) {
  const reason = process.platform === 'win32' && 'JEV_JOURNAL_UNSUPPORTED: private UID/mode/no-follow journal custody has no Windows implementation';
  if (reason) console.log('verify-not-run: ' + JSON.stringify({ file: new URL(import.meta.url).pathname, test: name, state: 'skipped', reason }));
  return test(name, { skip: reason }, fn);
}

const config = JSON.parse(await readFile(new URL('./jev.config.json', import.meta.url), 'utf8'));
const policy = JSON.parse(await readFile(new URL('./jev.review.config.json', import.meta.url), 'utf8'));
const key = 'local-test-secret-never-live';
const fixture = () => ({ schemaVersion: 2, process: { stage: 'validation', currentState: 'Failure unexplained', acceptedDecisions: ['Do not accept without proof'], nextStep: 'Investigate failure', reopenReason: null }, objective: 'Choose next validation action.', scope: 'host-test', revision: 'fixture-v1', evidence: [{ id: 'test', source: 'fixture', observedAt: '2026-09-19T00:00:00Z', observation: 'A test failed without a known cause.' }], constraints: ['Do not claim an unexplained failure fixed.'], unknowns: ['Failure cause'], options: [{ id: 'investigate', action: 'Inspect failure evidence', tradeoffs: ['Gain: reliable acceptance; loss: investigation time'], northStarImpact: 'Preserves evidence-based enterprise reliability', evidenceIds: ['test'] }, { id: 'accept', action: 'Accept without investigation', tradeoffs: ['Gain: immediate progress; loss: unresolved failure risk'], northStarImpact: 'Compromises reliable acceptance', evidenceIds: ['test'] }], checks: [{ id: 'supported', instructions: 'Is acceptance supported?', evidenceIds: ['test'] }] });
const transport = async (_url, options) => {
  const request = JSON.parse(options.body);
  return Response.json({ model: 'fixture-model', answers: Object.fromEntries(Object.entries(request.questions).map(([id, q]) => [id, q.type === 'noul' ? { type: 'noul', noul: 0.1 } : { type: 'choice', choice: 'investigate', confidence: 0.8, probabilities: { investigate: 0.9, accept: 0.05, none_of_the_above: 0.02, insufficient_information: 0.03 } }])), usage: { input_tokens: 10, output_tokens: 5 } });
};
async function sandbox(fn) {
  const root = await mkdtemp(join(tmpdir(), 'jev-journal-test-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
test('preparation preserves authored evidence/options, rejects dangling references and supplies two distinct abstention choices', () => {
  const c = fixture(); const p = prepare(c, policy);
  assert.deepEqual(p.input.state.case, c);
  assert.deepEqual(Object.keys(p.input.questions.next_action.criteria), ['investigate', 'accept', 'none_of_the_above', 'insufficient_information']);
  c.options[0].evidenceIds = ['invented']; assert.throws(() => prepare(c, policy), /JEV_OPTION/);
  c.options[0].evidenceIds = ['test']; c.checks[0].evidenceIds = []; assert.throws(() => prepare(c, policy), /JEV_CHECK/);
});
test('observation times accept past, equal and explicit unknown while rejecting future and impossible instants', () => {
  const at = '2026-09-20T10:00:00.000Z';
  const c = fixture();
  c.evidence = [
    { ...c.evidence[0], id: 'past', observedAt: '2026-09-20T09:59:59Z' },
    { ...c.evidence[0], id: 'equal', observedAt: at },
    { ...c.evidence[0], id: 'unknown', observedAt: null },
  ];
  c.options.forEach(option => { option.evidenceIds = ['past']; });
  c.checks[0].evidenceIds = ['past'];
  const prepared = prepare(c, policy, at);
  assert.deepEqual(prepared.diagnostics.observationTimes, { measured: 2, unknown: 1, freshness: 'not-measured' });
  c.evidence[0].observedAt = '2026-09-20T10:00:00.001Z';
  assert.throws(() => prepare(c, policy, at), /JEV_EVIDENCE_FUTURE/);
  c.evidence[0].observedAt = '2026-02-30T00:00:00Z';
  assert.throws(() => prepare(c, policy, at), /JEV_EVIDENCE/);
});
test('quality warnings are deterministic, nonblocking and leave authored context unchanged', () => {
  const c = fixture(); c.options[0].evidenceIds = [];
  c.options[0].action = 'Faster validation';
  c.options[1].tradeoffs = ['Immediate progress'];
  c.unknowns = [];
  const before = structuredClone(c);
  const risks = prepare(c, policy).diagnostics.sufficiencyRisks;
  assert.equal(risks.mode, 'advisory-only');
  assert.equal(risks.semanticQuality, 'not-measured');
  const codes = risks.warnings.map(w => w.code);
  for (const code of ['OPTION_WITHOUT_EVIDENCE', 'MEASUREMENT_SUPPORT_UNCLEAR', 'TRADEOFF_BALANCE_UNCLEAR', 'REJECTED_ALTERNATIVES_UNCLEAR', 'NO_EXPLICIT_UNKNOWNS']) assert.ok(codes.includes(code), code);
  assert.deepEqual(c, before);
  assert.deepEqual(prepare(c, policy).diagnostics.sufficiencyRisks, risks);
  assert.deepEqual(prepare(c, policy).input.state.case, before);
});
test('shared evidence, duplicated options and locator-only observations prompt specific review', () => {
  const c = fixture(); c.options[1].action = c.options[0].action;
  c.options[1].northStarImpact = c.options[0].northStarImpact;
  c.checks.push({ ...c.checks[0], id: 'another' });
  c.evidence[0].observation = '/unread/source.txt:10';
  const warnings = prepare(c, policy).diagnostics.sufficiencyRisks.warnings;
  for (const code of ['OPTIONS_SHARE_ALL_EVIDENCE', 'CHECKS_SHARE_ALL_EVIDENCE', 'DUPLICATE_OPTION_ACTION', 'IDENTICAL_NORTH_STAR_IMPACT', 'EVIDENCE_LOCATOR_ONLY']) assert.ok(warnings.some(w => w.code === code), code);
  c.checks[0].evidenceIds = [];
  assert.throws(() => prepare(c, policy), /JEV_CHECK/);
  c.checks[0].evidenceIds = ['not-authored'];
  assert.throws(() => prepare(c, policy), /JEV_CHECK/);
});
test('plan-only checks warn without claiming to understand untagged prose', () => {
  const c = fixture(); c.evidence[0].observation = '[plan] Run a regression test.';
  const codes = () => prepare(c, policy).diagnostics.sufficiencyRisks.warnings.map(w => w.code);
  assert.ok(codes().includes('CHECK_ONLY_UNVERIFIED_EVIDENCE'));
  c.evidence.push({ ...c.evidence[0], id: 'actual', observation: 'The recorded fixture failed.' });
  c.checks[0].evidenceIds.push('actual');
  assert.ok(!codes().includes('CHECK_ONLY_UNVERIFIED_EVIDENCE'));
});
test('measurement hint requires linked numeric units; a commit number is not a measurement', () => {
  const c = fixture(); c.options[0].action = 'Faster execution';
  c.evidence[0].observation = 'Revision 1234, tests 12/12 passed.';
  const warns = () => prepare(c, policy).diagnostics.sufficiencyRisks.warnings.some(w => w.code === 'MEASUREMENT_SUPPORT_UNCLEAR');
  assert.equal(warns(), true);
  c.evidence.push({ ...c.evidence[0], id: 'measurement', observation: 'At fixture-v1 on local CPU, 100 fixed inputs: p95 12 ms; 10 % less latency. No production extrapolation.' });
  assert.equal(warns(), true);
  c.options[0].evidenceIds.push('measurement');
  assert.equal(warns(), false);
  c.evidence[1].observation = '[plan] Target p95 12 ms';
  assert.equal(warns(), true);
  c.options[0].action = 'Reduce expenditure 20%';
  assert.equal(warns(), true);
  c.evidence[1].observation = 'Recorded workload comparison saved 20%';
  assert.equal(warns(), false);
  // A recognized number is only a cue; semantic quality remains unmeasured.
  assert.equal(prepare(c, policy).diagnostics.sufficiencyRisks.semanticQuality, 'not-measured');
});
test('explicit exclusions avoid inventing rejected options; full cases can have no warnings', () => {
  const c = fixture();
  c.process.acceptedDecisions.push('Rejected alternative: blind retry, because the failure cause is unknown.');
  c.evidence.push({ ...c.evidence[0], id: 'counter', observation: 'Accepting the unexplained failure supplies no correction proof.' });
  c.options[1].evidenceIds = ['counter'];
  assert.deepEqual(prepare(c, policy).diagnostics.sufficiencyRisks.warnings, []);
  c.process.acceptedDecisions[1] = 'Rejected alternatives: blind retry, cause unknown.';
  assert.deepEqual(prepare(c, policy).diagnostics.sufficiencyRisks.warnings, []);
  c.process.acceptedDecisions[1] = 'Reddedilen alternatif: kör tekrar; hata nedeni bilinmiyor.';
  c.options[0].tradeoffs = ['Kazanım: kanıt; kayıp: inceleme süresi'];
  assert.deepEqual(prepare(c, policy).diagnostics.sufficiencyRisks.warnings, []);
});
journalTest('warnings are journaled locally but do not change or accompany provider state/questions', async () => sandbox(async root => {
  const c = fixture(); c.options[0].evidenceIds = [];
  let calls = 0;
  const result = await consult(config, policy, c, root, key, async (...args) => {
    calls++;
    const wire = JSON.parse(args[1].body);
    assert.deepEqual(Object.keys(wire).sort(), ['model', 'questions', 'state']);
    assert.deepEqual(Object.keys(wire.state).sort(), ['case', 'northStar']);
    assert.deepEqual(wire.state.case, c);
    assert.equal(JSON.stringify(wire).includes('OPTION_WITHOUT_EVIDENCE'), false);
    return transport(...args);
  });
  assert.equal(calls, 1); assert.equal(result.status, 'advice');
  const request = await readEvent(result.directory, 'request.json');
  assert.ok(request.diagnostics.sufficiencyRisks.warnings.some(w => w.code === 'OPTION_WITHOUT_EVIDENCE'));
}));
test('future evidence is rejected before journal or transport work', async () => sandbox(async root => {
  let calls = 0;
  const c = fixture(); c.evidence[0].observedAt = '9999-12-31T23:59:59Z';
  await assert.rejects(consult(config, policy, c, root, key, async (...args) => { calls++; return transport(...args); }),
    /JEV_EVIDENCE_FUTURE/);
  assert.equal(calls, 0);
  assert.deepEqual(await readdir(root), []);
}));
test('duplicate/reserved choices and oversized context cannot reach network', async () => {
  for (const change of [c => { c.options[1].id = 'investigate'; }, c => { c.options[1].id = 'defer'; }, c => { c.options[1].id = 'none_of_the_above'; }, c => { c.options[1].id = 'insufficient_information'; }, c => { c.evidence.push(c.evidence[0]); }, c => { c.objective = 'x'.repeat(policy.maxCaseBytes); }]) {
    const c = fixture(); change(c); assert.throws(() => prepare(c, policy));
  }
});
journalTest('request exists before call; response, decision and labeled outcome are separate immutable evidence', async () => sandbox(async root => {
  const result = await consult(config, policy, fixture(), root, key, async (...args) => {
    const pending = await entries(root, 10);
    assert.equal(pending.ids.length, 1);
    const beforeSend = await readEvent(join(root, pending.ids[0]), 'request.json');
    assert.equal(beforeSend.case.objective, fixture().objective);
    const wire = JSON.parse(args[1].body);
    assert.deepEqual(wire.state, beforeSend.input.state);
    assert.deepEqual(wire.state.case.process, fixture().process);
    const charter = await readFile(new URL('../../.deckent/docs/core-memory/project_product_north_star.md', import.meta.url), 'utf8');
    assert.equal(wire.state.northStar.text, charter);
    assert.equal(wire.state.northStar.sha256, createHash('sha256').update(charter).digest('hex'));
    assert.match(wire.questions.next_action.instructions, /state.northStar/);
    return transport(...args);
  });
  const request = await readEvent(result.directory, 'request.json');
  assert.equal(request.requestSha256, result.requestSha256);
  const decision = { actor: 'test-operator', selectedOption: 'investigate', rationale: 'Failure is unexplained.', actions: ['Inspect test state.'], evidenceRefs: ['test'] };
  await followup(root, result.callId, 'decision', decision, key);
  await assert.rejects(followup(root, result.callId, 'decision', decision, key), { code: 'EEXIST' });
  await followup(root, result.callId, 'outcome', { actor: 'test-reviewer', status: 'verified', observation: 'Fixture verifies acceptance unsupported.', evidenceRefs: ['fixture-assertion'], labels: [{ questionId: 'supported', expected: false, evidenceRef: 'fixture-assertion' }], inputQuality: 'Fixture evidence is explicit.', outputQuality: 'Matches fixture label.' }, key);
  const summary = await report(root, 10);
  assert.equal(summary.sampledCalls, 1); assert.equal(summary.rows[0].agreement, true);
  assert.ok(Math.abs(summary.quality.brierScore - 0.01) < 1e-10);
  assert.equal(summary.usage.inputTokens, 10);
}));
journalTest('failures retain request and safe status; successful calls without labels do not claim quality', async () => sandbox(async root => {
  const failed = await consult(config, policy, fixture(), root, key, async () => new Response(key, { status: 429 }));
  assert.equal(failed.status, 'unavailable');
  const event = await readEvent(failed.directory, 'failure.json'); assert.equal(event.error, 'JEV_HTTP_429');
  assert.ok(!JSON.stringify(event).includes(key));
  await consult(config, policy, fixture(), root, key, transport);
  const summary = await report(root, 10); assert.equal(summary.quality.brierScore, null);
  assert.equal(summary.rows.filter(r => r.status === 'unavailable').length, 1);
}));
journalTest('parallel calls have isolated journals and reports disclose truncation', async () => sandbox(async root => {
  const calls = await Promise.all(Array.from({ length: 5 }, () => consult(config, policy, fixture(), root, key, transport)));
  assert.equal(new Set(calls.map(c => c.callId)).size, 5);
  const summary = await report(root, 2); assert.equal(summary.sampledCalls, 2); assert.equal(summary.truncated, true);
}));
journalTest('secret rejection and symlink journal rejection happen before network', async () => sandbox(async root => {
  let calls = 0; const fake = async (...args) => { calls++; return transport(...args); };
  const c = fixture(); c.objective = key;
  await assert.rejects(consult(config, policy, c, root, key, fake), /JEV_SECRET_IN_JOURNAL/);
  await symlink(root, join(root, 'redirect'));
  await assert.rejects(consult(config, policy, fixture(), join(root, 'redirect'), key, fake), /JEV_JOURNAL_PATH/);
  assert.equal(calls, 0);
}));
journalTest('invalid decision and unsupported labels fail without overwriting the record', async () => sandbox(async root => {
  const call = await consult(config, policy, fixture(), root, key, transport);
  await assert.rejects(followup(root, call.callId, 'decision', { actor: 'x', selectedOption: 'invented', rationale: 'x', actions: [], evidenceRefs: [] }, key), /JEV_DECISION_OPTION/);
  await assert.rejects(followup(root, '../escape', 'decision', {}, key), /JEV_CALL_ID/);
  await assert.rejects(followup(root, call.callId, 'outcome', { actor: 'x', status: 'verified', observation: 'x', evidenceRefs: [], labels: [], inputQuality: 'x', outputQuality: 'x' }, key), /JEV_OUTCOME_EVIDENCE/);
}));

journalTest('a persisted request without response remains unknown, not failed or successful', async () => sandbox(async root => {
  const id = callId();
  await writeEvent(join(root, id), 'request.json', { case: fixture(), input: prepare(fixture(), policy).input }, key);
  const summary = await report(root, 10);
  assert.equal(summary.rows[0].status, 'response-unknown');
  assert.equal(summary.rows[0].outcome, 'unobserved');
  assert.equal(summary.usage.inputTokens, 0);
  assert.equal(summary.usage.excludesFailedAndUnrecordedUsage, true);
}));

journalTest('abstention choices survive response, decision and reporting as distinct signals', async () => sandbox(async root => {
  for (const selected of ['none_of_the_above', 'insufficient_information']) {
    const result = await consult(config, policy, fixture(), root, key, async (_url, options) => {
      const { questions } = JSON.parse(options.body);
      return Response.json({ model: 'fixture-model', answers: Object.fromEntries(Object.entries(questions).map(([id, q]) => [id,
        q.type === 'noul' ? { type: 'noul', noul: 0.5 } : { type: 'choice', choice: selected, confidence: 0.8,
          probabilities: Object.fromEntries(Object.keys(q.criteria).map(option => [option, option === selected ? 1 : 0])) }])), usage: { input_tokens: 1, output_tokens: 1 } });
    });
    await followup(root, result.callId, 'decision', { actor: 'test', selectedOption: selected, rationale: 'Fixture signal, not correctness proof.', actions: [], evidenceRefs: [] }, key);
  }
  const summary = await report(root, 10);
  assert.deepEqual(summary.abstentions.none_of_the_above, { offered: 2, selected: 1 });
  assert.deepEqual(summary.abstentions.insufficient_information, { offered: 2, selected: 1 });
  assert.deepEqual(summary.abstentions.defer, { offered: 0, selected: 0 });
  assert.equal(summary.quality.brierScore, null);
  assert.equal(summary.rows.every(r => r.agreement === true), true);
}));

journalTest('historical defer is interpreted from the recorded request, never relabeled', async () => sandbox(async root => {
  const id = callId(); const input = prepare(fixture(), policy).input;
  input.questions.next_action.criteria = { investigate: 'Inspect', accept: 'Accept', defer: 'Old combined deferral' };
  await writeEvent(join(root, id), 'request.json', { case: fixture(), input }, key);
  await followup(root, id, 'decision', { actor: 'test', selectedOption: 'defer', rationale: 'Historic meaning retained.', actions: [], evidenceRefs: [] }, key);
  const summary = await report(root, 10);
  assert.deepEqual(summary.abstentions.defer, { offered: 1, selected: 0 });
  assert.deepEqual(summary.abstentions.insufficient_information, { offered: 0, selected: 0 });
  assert.equal(summary.rows[0].selectedOption, 'defer');
  assert.equal(summary.rows[0].abstentionProbabilities.insufficient_information, null);
}));

test('decision context cannot omit process or impact, override the shared charter, or submit legacy cases', async () => sandbox(async root => {
  let calls = 0;
  for (const mutate of [c => { delete c.process; }, c => { c.process.acceptedDecisions = []; },
    c => { c.process.reopenReason = ''; }, c => { delete c.options[0].northStarImpact; },
    c => { c.northStar = 'override'; }, c => { c.schemaVersion = 1; }]) {
    const c = fixture(); mutate(c);
    await assert.rejects(consult(config, policy, c, root, key, async (...args) => { calls++; return transport(...args); }));
  }
  assert.equal(calls, 0);
  assert.deepEqual(await readdir(root), []);
}));

test('full wire budget and secrets in the injected charter fail before network', async () => sandbox(async root => {
  let calls = 0;
  const fake = async (...args) => { calls++; return transport(...args); };
  const c = fixture();
  const prepared = prepare(c, policy);
  const bytesWithoutCharter = Buffer.byteLength(JSON.stringify({ model: config.model, state: c, questions: prepared.input.questions }));
  await assert.rejects(consult({ ...config, maxRequestBytes: bytesWithoutCharter }, policy, c, root, key, fake), /JEV_REQUEST_TOO_LARGE/);
  await assert.rejects(consult(config, policy, c, root, 'customer-installed Agent OS', fake), /JEV_SECRET_IN_JOURNAL/);
  assert.equal(calls, 0);
  assert.deepEqual(await readdir(root), []);
}));


test('secret-bearing case is rejected before journal custody or transport on every platform', async () => sandbox(async root => {
  let calls = 0; const c = fixture(); c.objective = key;
  await assert.rejects(consult(config, policy, c, root, key, async () => { calls++; throw new Error('unexpected transport'); }), /JEV_SECRET_IN_JOURNAL/);
  assert.equal(calls, 0); assert.deepEqual(await readdir(root), []);
}));
