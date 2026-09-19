import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepare } from './jev-context.mjs';
import { consult, followup, report } from './jev-review.mjs';
import { readEvent, writeEvent, callId, entries } from './jev-journal.mjs';
const config = JSON.parse(await readFile(new URL('./jev.config.json', import.meta.url), 'utf8'));
const policy = JSON.parse(await readFile(new URL('./jev.review.config.json', import.meta.url), 'utf8'));
const key = 'local-test-secret-never-live';
const fixture = () => ({ schemaVersion: 1, objective: 'Choose next validation action.', scope: 'host-test', revision: 'fixture-v1', evidence: [{ id: 'test', source: 'fixture', observedAt: '2026-09-19T00:00:00Z', observation: 'A test failed without a known cause.' }], constraints: ['Do not claim an unexplained failure fixed.'], unknowns: ['Failure cause'], options: [{ id: 'investigate', action: 'Inspect failure evidence', tradeoffs: ['Consumes time'], evidenceIds: ['test'] }, { id: 'accept', action: 'Accept without investigation', tradeoffs: ['Unresolved failure risk'], evidenceIds: ['test'] }], checks: [{ id: 'supported', instructions: 'Is acceptance supported?', evidenceIds: ['test'] }] });
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
  assert.deepEqual(p.input.state, c);
  assert.deepEqual(Object.keys(p.input.questions.next_action.criteria), ['investigate', 'accept', 'none_of_the_above', 'insufficient_information']);
  c.options[0].evidenceIds = ['invented']; assert.throws(() => prepare(c, policy), /JEV_OPTION/);
  c.options[0].evidenceIds = ['test']; c.checks[0].evidenceIds = []; assert.throws(() => prepare(c, policy), /JEV_CHECK/);
});
test('duplicate/reserved choices and oversized context cannot reach network', async () => {
  for (const change of [c => { c.options[1].id = 'investigate'; }, c => { c.options[1].id = 'defer'; }, c => { c.options[1].id = 'none_of_the_above'; }, c => { c.options[1].id = 'insufficient_information'; }, c => { c.evidence.push(c.evidence[0]); }, c => { c.objective = 'x'.repeat(policy.maxCaseBytes); }]) {
    const c = fixture(); change(c); assert.throws(() => prepare(c, policy));
  }
});
test('request exists before call; response, decision and labeled outcome are separate immutable evidence', async () => sandbox(async root => {
  const result = await consult(config, policy, fixture(), root, key, async (...args) => {
    const pending = await entries(root, 10);
    assert.equal(pending.ids.length, 1);
    const beforeSend = await readEvent(join(root, pending.ids[0]), 'request.json');
    assert.equal(beforeSend.case.objective, fixture().objective);
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
test('failures retain request and safe status; successful calls without labels do not claim quality', async () => sandbox(async root => {
  const failed = await consult(config, policy, fixture(), root, key, async () => new Response(key, { status: 429 }));
  assert.equal(failed.status, 'unavailable');
  const event = await readEvent(failed.directory, 'failure.json'); assert.equal(event.error, 'JEV_HTTP_429');
  assert.ok(!JSON.stringify(event).includes(key));
  await consult(config, policy, fixture(), root, key, transport);
  const summary = await report(root, 10); assert.equal(summary.quality.brierScore, null);
  assert.equal(summary.rows.filter(r => r.status === 'unavailable').length, 1);
}));
test('parallel calls have isolated journals and reports disclose truncation', async () => sandbox(async root => {
  const calls = await Promise.all(Array.from({ length: 5 }, () => consult(config, policy, fixture(), root, key, transport)));
  assert.equal(new Set(calls.map(c => c.callId)).size, 5);
  const summary = await report(root, 2); assert.equal(summary.sampledCalls, 2); assert.equal(summary.truncated, true);
}));
test('secret rejection and symlink journal rejection happen before network', async () => sandbox(async root => {
  let calls = 0; const fake = async (...args) => { calls++; return transport(...args); };
  const c = fixture(); c.objective = key;
  await assert.rejects(consult(config, policy, c, root, key, fake), /JEV_SECRET_IN_JOURNAL/);
  await symlink(root, join(root, 'redirect'));
  await assert.rejects(consult(config, policy, fixture(), join(root, 'redirect'), key, fake), /JEV_JOURNAL_PATH/);
  assert.equal(calls, 0);
}));
test('invalid decision and unsupported labels fail without overwriting the record', async () => sandbox(async root => {
  const call = await consult(config, policy, fixture(), root, key, transport);
  await assert.rejects(followup(root, call.callId, 'decision', { actor: 'x', selectedOption: 'invented', rationale: 'x', actions: [], evidenceRefs: [] }, key), /JEV_DECISION_OPTION/);
  await assert.rejects(followup(root, '../escape', 'decision', {}, key), /JEV_CALL_ID/);
  await assert.rejects(followup(root, call.callId, 'outcome', { actor: 'x', status: 'verified', observation: 'x', evidenceRefs: [], labels: [], inputQuality: 'x', outputQuality: 'x' }, key), /JEV_OUTCOME_EVIDENCE/);
}));

test('a persisted request without response remains unknown, not failed or successful', async () => sandbox(async root => {
  const id = callId();
  await writeEvent(join(root, id), 'request.json', { case: fixture(), input: prepare(fixture(), policy).input }, key);
  const summary = await report(root, 10);
  assert.equal(summary.rows[0].status, 'response-unknown');
  assert.equal(summary.rows[0].outcome, 'unobserved');
  assert.equal(summary.usage.inputTokens, 0);
  assert.equal(summary.usage.excludesFailedAndUnrecordedUsage, true);
}));

test('abstention choices survive response, decision and reporting as distinct signals', async () => sandbox(async root => {
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

test('historical defer is interpreted from the recorded request, never relabeled', async () => sandbox(async root => {
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
