import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScorer, decodeScores, validateLocalConfig, wireFor } from './qwen-decision-client.mjs';
import { createDecisionEngine } from './qwen-decision-store.mjs';
import { callId, writeEvent, readEvent } from './jev-journal.mjs';
import { parseActivity, requireIdle } from './qwen-decision-idle.mjs';

const config = { ...JSON.parse(await readFile(new URL('./qwen-decision.config.json', import.meta.url))), model: 'fixture-qwen' };
const policy = JSON.parse(await readFile(new URL('./jev.review.config.json', import.meta.url)));
const c = () => ({ schemaVersion: 2, objective: 'Choose evidence-based action', scope: 'host-fixture', revision: 'fixture-1',
  process: { stage: 'test', currentState: 'Full verify EXIT1', acceptedDecisions: ['No acceptance without evidence'],
    nextStep: 'Inspect failure', reopenReason: null }, constraints: ['No product effects'], unknowns: ['Root cause'],
  evidence: [{ id: 'exit', source: 'fixture-exit-code', observedAt: null, observation: 'Full verify exited 1, two failures.' }],
  options: [{ id: 'investigate', action: 'Inspect failure', tradeoffs: ['Gain: evidence; loss: time'], northStarImpact: 'Preserves correctness', evidenceIds: ['exit'] },
    { id: 'accept', action: 'Accept', tradeoffs: ['Gain: speed; loss: unsupported acceptance'], northStarImpact: 'Unproven reliability', evidenceIds: ['exit'] }],
  checks: [{ id: 'accepted', instructions: 'Is full verification accepted?', evidenceIds: ['exit'] }] });
const binary = { type: 'noul', instructions: 'Supported?' };
const input = { schemaVersion: 1, state: { evidence: 'EXIT1' }, questions: { supported: binary } };
function response(probabilities = [0.1, 0.9], overrides = {}) {
  return { model: config.model, choices: [{ message: { content: 'A', reasoning: null },
    logprobs: { content: [{ token: 'A', top_logprobs: probabilities.map((p, i) => ({ token: String.fromCharCode(65 + i), logprob: Math.log(p) })) }] } }],
  usage: { prompt_tokens: 25, completion_tokens: 1, completion_tokens_details: { reasoning_tokens: 0 } }, ...overrides };
}
function fakeTransport(log, score = async () => response()) {
  return async (url, opts) => {
    if (new URL(url).pathname === '/metrics') return new Response(`vllm:num_requests_running{model_name="${config.model}"} 0\nvllm:num_requests_waiting{model_name="${config.model}"} 0\n`);
    const body = JSON.parse(opts.body); log.push({ url: String(url), body, opts });
    if (new URL(url).pathname === '/tokenize') return Response.json({ tokens: [body.prompt.charCodeAt(0) - 33] });
    const count = body.logprob_token_ids.length;
    return score(body, count);
  };
}
async function sandbox(fn) {
  const root = await mkdtemp(join(tmpdir(), 'qwen-decision-test-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
const supported = process.platform === 'win32' ? 'Private UID/mode journal is unsupported on Windows' : false;
const localTest = (name, fn) => test(name, { skip: supported }, fn);

test('only explicit literal loopback endpoint and bounded configuration are admitted', () => {
  for (const baseUrl of ['https://example.com', 'http://localhost:18080', 'http://127.0.0.1@evil.test',
    'http://127.0.0.1/x', 'http://127.0.0.1?q=x', 'http://127.0.0.1#x'])
    assert.throws(() => validateLocalConfig({ ...config, baseUrl }), /QWEN_LOOPBACK_ONLY/);
  for (const change of [{ timeoutMs: 999999 }, { maxOptions: 27 }, { maxQuestions: 99 }, { port: 65536 },
    { minCodeMass: 0 }, { maxResponseBytes: 99999999 }, { unexpected: true }])
    assert.throws(() => validateLocalConfig({ ...config, ...change }), /QWEN_CONFIG/);
});
test('idle observations require both metrics for the exact model; unknown and busy fail closed', async () => {
  const text = `vllm:num_requests_running{engine="0",model_name="${config.model}"} 0\nvllm:num_requests_waiting{engine="0",model_name="${config.model}"} 0\nvllm:kv_cache_usage_perc{engine="0",model_name="${config.model}"} 0.4`;
  const idle = parseActivity(text, config.model); assert.equal(idle.kvCacheFraction, 0.4);
  assert.equal(idle.admission, 'idle-snapshot-not-exclusive-reservation');
  for (const bad of ['', text.replace(/num_requests_waiting/g, 'other'), text.replace(/fixture-qwen/g, 'another-model'), text.replace('} 0\n', '} NaN\n')])
    assert.throws(() => parseActivity(bad, config.model), /QWEN_ACTIVITY_UNKNOWN/);
  await assert.rejects(requireIdle(config, async () => new Response(text.replace('} 0\n', '} 1\n'))), /QWEN_SERVER_BUSY/);
  await assert.rejects(requireIdle(config, async () => new Response('', { status: 503 })), /QWEN_ACTIVITY_UNKNOWN/);
});
localTest('busy chat prevents a new intent and all scoring; existing completed advice still replays', async () => sandbox(async root => {
  const log = []; let busy = false; const base = fakeTransport(log, async (_b, count) => Response.json(response(Array(count).fill(1 / count))));
  const engine = createDecisionEngine({ config, policy, root, transport: async (url, opts) =>
    busy && new URL(url).pathname === '/metrics'
      ? new Response(`vllm:num_requests_running{model_name="${config.model}"} 1\nvllm:num_requests_waiting{model_name="${config.model}"} 0`)
      : base(url, opts) });
  const id = callId(); assert.equal((await engine.ask(c(), { id })).status, 'advice');
  const before = log.length; busy = true;
  assert.equal((await engine.ask(c(), { id })).replayed, true);
  const blockedId = callId(); await assert.rejects(engine.ask(c(), { id: blockedId }), /QWEN_SERVER_BUSY/);
  assert.equal(log.length, before);
  await assert.rejects(readFile(join(root, blockedId, 'request.json')), { code: 'ENOENT' });
  assert.equal((await engine.report()).sampledCalls, 1);
}));
test('raw next-token option scores select by probability, never by sampled code or generated JSON', () => {
  const q = { type: 'choice', instructions: 'choose', criteria: { alpha: 'Alpha', beta: 'Beta' } };
  const r = decodeScores(response(), q, config.model, 0.8);
  assert.equal(r.answer.choice, 'beta'); assert.equal(r.observation.sampledCode, 'A');
  assert.ok(Math.abs(r.answer.probabilities.beta - 0.9) < 1e-12);
  assert.ok(Math.abs(r.answer.confidence - 0.8) < 1e-12);
  assert.deepEqual(r.usage, { input_tokens: 25, output_tokens: 1 });
  assert.ok(Math.abs(decodeScores(response(), binary, config.model, 0.8).answer.noul - 0.1) < 1e-12);
  const score = decodeScores(response(), { type: 'score', instructions: 'rate', criteria: ['low', 'high'] }, config.model, 0.8);
  assert.ok(Math.abs(score.answer.score - 0.9) < 1e-12);
  assert.deepEqual(score.answer.legend, { 0: 'low', 1: 'high' });
});
test('missing, duplicated, impossible or low-mass scores never produce fabricated advice', () => {
  assert.throws(() => decodeScores(response([0.9]), binary, config.model, 0.8), /QWEN_INCOMPLETE_LOGPROBS/);
  assert.throws(() => decodeScores(response([0.01, 0.01]), binary, config.model, 0.8), /QWEN_LOW_CODE_MASS/);
  assert.throws(() => decodeScores(response([0.9, 0.9]), binary, config.model, 0.8), /QWEN_LOW_CODE_MASS/);
  const duplicate = response(); duplicate.choices[0].logprobs.content[0].top_logprobs.push({ token: 'A', logprob: -1 });
  assert.throws(() => decodeScores(duplicate, binary, config.model, 0.8), /QWEN_LOGPROBS/);
  const sentinel = response(); sentinel.choices[0].logprobs.content[0].top_logprobs[0].logprob = -9999;
  assert.throws(() => decodeScores(sentinel, binary, config.model, 0.8), /QWEN_LOGPROBS/);
  assert.throws(() => decodeScores(response(undefined, { model: 'wrong-model' }), binary, config.model, 0.8), /QWEN_RESPONSE/);
  const thinking = response(); thinking.usage.completion_tokens_details.reasoning_tokens = 1;
  assert.throws(() => decodeScores(thinking, binary, config.model, 0.8), /QWEN_USAGE/);
});
test('request-local non-thinking and full-probability parameters do not change terminal defaults', () => {
  const wire = wireFor(config, input.state, binary, [32, 33]);
  assert.deepEqual(wire.chat_template_kwargs, { enable_thinking: false });
  assert.deepEqual(wire.logprob_token_ids, [32, 33]); assert.equal(wire.max_tokens, 1);
  assert.equal(wire.temperature, 1); assert.equal(wire.top_p, 1); assert.equal(wire.top_k, -1);
  for (const key of ['tools', 'allowed_token_ids', 'structured_outputs', 'logit_bias']) assert.equal(key in wire, false);
});
test('tokenizer validation, inference timeout and input limits happen before any scoring request', async () => {
  let scoreCalls = 0;
  const scorer = createScorer(config, async (url) => {
    if (new URL(url).pathname !== '/tokenize') scoreCalls++;
    return Response.json({ tokens: [1, 2] });
  });
  await assert.rejects(scorer.score(input), /QWEN_CODE_NOT_SINGLE_TOKEN/); assert.equal(scoreCalls, 0);
  const log = []; const good = createScorer(config, fakeTransport(log));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(good.score(input, { signal: controller.signal })); assert.equal(log.length, 0);
  await assert.rejects(good.score({ ...input, questions: Object.fromEntries(Array.from({ length: 13 }, (_, i) => [String(i), binary])) }), /QWEN_QUESTION_LIMIT/);
  assert.equal(log.length, 0);
});
localTest('request journal precedes every send, records both abstentions and replays without GPU calls', async () => sandbox(async root => {
  const log = []; const id = callId();
  const engine = createDecisionEngine({ config, policy, root, transport: fakeTransport(log, async (_body, count) => {
    const request = await readEvent(join(root, id), 'request.json');
    assert.equal(request.provider, 'local-qwen');
    return Response.json(response(count === 4 ? [0.05, 0.05, 0.1, 0.8] : [0.1, 0.9]));
  }) });
  const r = await engine.ask(c(), { id }); assert.equal(r.status, 'advice');
  assert.equal(r.answers.next_action.choice, 'insufficient_information');
  assert.deepEqual(Object.keys(r.answers.next_action.probabilities), ['investigate', 'accept', 'none_of_the_above', 'insufficient_information']);
  assert.equal(r.calibration, 'not-measured'); assert.equal(r.acceptance, 'not-assessed');
  const calls = log.length; const replay = await engine.ask(c(), { id });
  assert.equal(replay.replayed, true); assert.equal(log.length, calls);
  const conflict = c(); conflict.objective = 'Different case';
  await assert.rejects(engine.ask(conflict, { id }), /QWEN_COMMAND_CONFLICT/); assert.equal(log.length, calls);
  await engine.followup(id, 'decision', { actor: 'fixture', selectedOption: 'insufficient_information', rationale: 'Fixture', actions: [], evidenceRefs: ['exit'] });
  const report = await engine.report(); assert.equal(report.rows[0].agreement, true);
  assert.equal(report.quality.brierScore, null); assert.equal(report.calibration, 'not-measured');
  assert.equal(report.automaticRouting, false);
}));
localTest('transport failure, cancellation and partial progress remain unknown and cannot silently retry', async () => sandbox(async root => {
  const log = []; let calls = 0;
  const engine = createDecisionEngine({ config, policy, root, transport: fakeTransport(log, async () => {
    calls++; if (calls === 2) throw new Error('secret/private error detail'); return Response.json(response());
  }) });
  const id = callId(); const r = await engine.ask(c(), { id });
  assert.equal(r.status, 'unknown'); assert.equal(r.error, 'QWEN_RESULT_UNKNOWN');
  assert.equal((await readEvent(join(root, id), 'answer-1.json')).usage.output_tokens, 1);
  const before = log.length; assert.equal((await engine.ask(c(), { id })).status, 'unknown');
  assert.equal(log.length, before); assert.equal((await engine.report()).rows[0].status, 'unknown');
  const failed = await readEvent(join(root, id), 'failure.json');
  assert.equal(failed.usage, 'unknown'); assert.equal(JSON.stringify(failed).includes('secret/private'), false);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(engine.ask(c(), { signal: controller.signal }));
  assert.equal(log.length, before);
}));
localTest('persisted pending request and simultaneous command collision cannot resend', async () => sandbox(async root => {
  let calls = 0; let release;
  const pending = new Promise(resolve => { release = resolve; });
  const id = callId(); const engine = createDecisionEngine({ config, policy, root,
    transport: fakeTransport([], async (_body, count) => { calls++; await pending; return Response.json(response(Array(count).fill(1 / count))); }) });
  const first = engine.ask(c(), { id });
  // Wait for persisted intent via filesystem, never synchronize on assumed execution time.
  for (;;) { try { await readEvent(join(root, id), 'request.json'); break; } catch (e) { if (e.code !== 'ENOENT') throw e; await new Promise(r => setTimeout(r, 1)); } }
  assert.equal((await engine.ask(c(), { id })).status, 'unknown'); release();
  assert.equal((await first).status, 'advice'); assert.equal(calls, 3);
  const pendingId = callId(); await writeEvent(join(root, pendingId), 'request.json', { callId: pendingId, requestSha256: 'pending' });
  assert.equal((await engine.inspect(pendingId)).status, 'unknown');
}));
localTest('invalid case and known API secret never create a request or reach transport', async () => sandbox(async root => {
  let calls = 0;
  const engine = createDecisionEngine({ config, policy, root, secret: 'do-not-log-me', transport: async () => { calls++; } });
  const secret = c(); secret.objective = 'do-not-log-me';
  await assert.rejects(engine.ask(secret), /JEV_SECRET_IN_JOURNAL/);
  const bad = c(); bad.options[0].evidenceIds = ['missing'];
  await assert.rejects(engine.ask(bad), /JEV_OPTION/); assert.equal(calls, 0);
}));
