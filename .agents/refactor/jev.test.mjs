import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, chmod, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ask, readCredential, validateInput, validateResponse, failureDiagnostics } from './jev.mjs';
const config = JSON.parse(await readFile(new URL('./jev.config.json', import.meta.url), 'utf8'));
const key = 'test-private-token-not-live';
const input = { schemaVersion: 1, state: { fact: 'A failed test remains unresolved.' }, questions: { proven: { type: 'noul', instructions: 'Is the fix proven?' } } };
const reply = { model: 'test-model', answers: { proven: { type: 'noul', noul: 0.1 } }, usage: { input_tokens: 10, output_tokens: 2 } };
test('sends only authored state; validates advisory receipt without echoing state or key', async () => {
  const result = await ask(config, input, key, async (url, options) => {
    assert.equal(url, config.endpoint); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${key}`);
    assert.deepEqual(JSON.parse(options.body), { model: config.model, state: input.state, questions: input.questions });
    return Response.json(reply);
  });
  assert.equal(result.advisoryOnly, true); assert.equal(result.acceptance, 'not-assessed');
  assert.equal(result.model, 'test-model'); assert.equal(result.requestSha256.length, 64);
  assert.ok(!JSON.stringify(result).includes(key)); assert.ok(!JSON.stringify(result).includes(input.state.fact));
});
test('rejects missing/foreign answers, wrong types and invalid probabilities', () => {
  for (const answers of [{}, { other: reply.answers.proven }, { proven: { type: 'score', noul: 0.1 } }, { proven: { type: 'noul', noul: 1.2 } }]) {
    assert.throws(() => validateResponse({ ...reply, answers }, input.questions));
  }
  assert.throws(() => validateInput({ ...input, model: 'override' }));
});
test('choice and score retain distributions but reject unknown options and invalid legends', () => {
  const questions = { route: { type: 'choice', instructions: 'Select', criteria: { a: 'A', b: 'B' } }, quality: { type: 'score', instructions: 'Rate', criteria: ['Low', 'High'] } };
  validateInput({ ...input, questions });
  const answers = { route: { type: 'choice', choice: 'a', probabilities: { a: 0.8, b: 0.2 }, confidence: 0.6 }, quality: { type: 'score', score: 0.8, probabilities: { 0: 0.2, 1: 0.8 }, legend: { 0: 'Low', 1: 'High' }, confidence: 0.6 } };
  assert.equal(validateResponse({ ...reply, answers }, questions).answers.route.choice, 'a');
  answers.route.choice = 'unknown'; assert.throws(() => validateResponse({ ...reply, answers }, questions));
  answers.route.choice = 'a'; answers.quality.legend[1] = 'wrong'; assert.throws(() => validateResponse({ ...reply, answers }, questions));
});
test('HTTP errors are typed, body is not exposed and no automatic retries occur', async () => {
  for (const status of [401, 422, 429, 529]) {
    let calls = 0;
    await assert.rejects(ask(config, input, key, async () => { calls++; return new Response(key, { status }); }), { message: `JEV_HTTP_${status}` });
    assert.equal(calls, 1);
  }
});
test('request/response limits and known credential in state fail closed', async () => {
  let calls = 0;
  const transport = async () => { calls++; return Response.json(reply); };
  await assert.rejects(ask({ ...config, maxRequestBytes: 5 }, input, key, transport), /JEV_REQUEST_TOO_LARGE/);
  await assert.rejects(ask(config, { ...input, state: key }, key, transport), /JEV_SECRET_IN_PAYLOAD/);
  assert.equal(calls, 0);
  await assert.rejects(ask({ ...config, maxResponseBytes: 5 }, input, key, transport), /JEV_RESPONSE_TOO_LARGE/);
});
test('credentials require private regular owner file; symlinks and broad permissions fail', async t => {
  if (process.platform === 'win32') {
    const reason = 'JEV_CREDENTIAL_FILE_UNSUPPORTED: Windows lacks private UID/mode/no-follow credential file custody';
    console.log('verify-not-run: ' + JSON.stringify({ file: '.agents/refactor/jev.test.mjs', test: t.name, state: 'skipped', reason }));
    t.skip(reason); return;
  }
  const dir = await mkdtemp(join(tmpdir(), 'jev-credential-test-'));
  const path = join(dir, 'key');
  try {
    await writeFile(path, key, { mode: 0o600 });
    const env = { [config.credentialFileEnv]: path };
    assert.equal(await readCredential(config, env), key);
    await chmod(path, 0o644); await assert.rejects(readCredential(config, env), /JEV_CREDENTIAL_FILE/);
    await chmod(path, 0o600); await symlink(path, join(dir, 'link'));
    await assert.rejects(readCredential(config, { [config.credentialFileEnv]: join(dir, 'link') }));
    await assert.rejects(readCredential({ ...config, credentialFile: undefined }, {}), /JEV_CREDENTIAL_MISSING/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('timeout aborts the request without returning a verdict', async () => {
  // A real I/O-like pending operation keeps the event loop alive while the timeout fires.
  await assert.rejects(ask({ ...config, timeoutMs: 10 }, input, key, async (_url, { signal }) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(Response.json(reply)), 1000);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  })), { name: 'TimeoutError' });
});
test('malformed response and credential echo cannot become advice', async () => {
  await assert.rejects(ask(config, input, key, async () => new Response('not-json')));
  await assert.rejects(ask(config, input, key, async () => Response.json({ ...reply, model: key })), /JEV_SECRET_IN_RESPONSE/);
});


test('environment credentials stay portable while Windows credential-file custody refuses before opening a missing path', async () => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    Object.defineProperty(process, 'platform', { ...original, value: 'win32' });
    assert.equal(await readCredential(config, { [config.credentialEnv]: key }), key);
    await assert.rejects(readCredential(config, { [config.credentialFileEnv]: 'missing-do-not-open' }), /JEV_CREDENTIAL_FILE_UNSUPPORTED/);
  } finally { Object.defineProperty(process, 'platform', original); }
});

test('null or missing usage counts normalize to unknown, never zero; invalid counts and invalid answers stay rejected', async () => {
  for (const [usage, expected] of [
    [undefined, { input_tokens: 'unknown', output_tokens: 'unknown' }],
    [null, { input_tokens: 'unknown', output_tokens: 'unknown' }],
    [{ input_tokens: null, output_tokens: null }, { input_tokens: 'unknown', output_tokens: 'unknown' }],
    [{ input_tokens: 12 }, { input_tokens: 12, output_tokens: 'unknown' }],
    [{ input_tokens: null, output_tokens: 0 }, { input_tokens: 'unknown', output_tokens: 0 }],
  ]) {
    const response = { ...reply, usage }; if (usage === undefined) delete response.usage;
    assert.deepEqual(validateResponse(response, input.questions).usage, expected);
  }
  for (const usage of [{ input_tokens: -1, output_tokens: 0 }, { input_tokens: '10', output_tokens: 0 }, { input_tokens: 1.5, output_tokens: 0 },
    { input_tokens: 1, output_tokens: Number.MAX_SAFE_INTEGER + 1 }, 'unknown', [10, 2], 0]) {
    assert.throws(() => validateResponse({ ...reply, usage }, input.questions), /JEV_USAGE/);
  }
  // Unknown metering does not make an invalid answer acceptable.
  assert.throws(() => validateResponse({ ...reply, usage: null, answers: { proven: { type: 'noul', noul: 1.2 } } }, input.questions), /JEV_ANSWER/);
  const result = await ask(config, input, key, async () => Response.json({ ...reply, usage: { input_tokens: null, output_tokens: null } }));
  assert.deepEqual(result.usage, { input_tokens: 'unknown', output_tokens: 'unknown' });
  assert.equal(result.advisoryOnly, true);
});

test('rejected replies keep safe stage, request id, distribution sum/count and known usage; the sum rule is unchanged', async () => {
  const questions = { route: { type: 'choice', instructions: 'Select', criteria: { a: 'A', b: 'B', c: 'C' } } };
  const offSum = { model: 'jev-1.13.0', answers: { route: { type: 'choice', choice: 'a', probabilities: { a: 0.5, b: 0.3, c: 0.15 }, confidence: 0.25 } }, usage: { input_tokens: 900, output_tokens: null } };
  const error = await ask(config, { ...input, questions }, key, async () => Response.json(offSum, { headers: { 'x-typesafe-request-id': 'req_01HXYZ-abc.def' } })).catch(e => e);
  assert.equal(error.message, 'JEV_DISTRIBUTION_SUM');
  const d = failureDiagnostics(error, key);
  assert.equal(d.stage, 'validate'); assert.equal(d.requestId, 'req_01HXYZ-abc.def'); assert.equal(d.servedModel, 'jev-1.13.0');
  assert.equal(d.httpStatus, 200); assert.equal(d.responseSha256.length, 64);
  assert.deepEqual(d.usage, { input_tokens: 900, output_tokens: 'unknown' });
  assert.deepEqual(d.answerKeys, { expected: 1, received: 1 });
  assert.equal(d.distributions.length, 1);
  const [dist] = d.distributions;
  assert.equal(dist.questionId, 'route'); assert.equal(dist.count, 3); assert.equal(dist.expectedCount, 3); assert.equal(dist.keysMatch, true);
  assert.ok(Math.abs(dist.sum - 0.95) < 1e-12); assert.equal(dist.min, 0.15); assert.equal(dist.max, 0.5);
  // The existing tolerance stays < 0.001: a 0.9991 sum passes, 0.998 rejects.
  const within = structuredClone(offSum); within.answers.route.probabilities = { a: 0.5, b: 0.3, c: 0.1991 };
  assert.equal(validateResponse(within, questions).answers.route.choice, 'a');
  const edge = structuredClone(offSum); edge.answers.route.probabilities = { a: 0.5, b: 0.3, c: 0.198 };
  assert.throws(() => validateResponse(edge, questions), /JEV_DISTRIBUTION_SUM/);
});

test('diagnostics never retain secrets, error bodies, foreign keys or provider prose', async () => {
  const leak = `${key} provider stack trace: secret-error-body`;
  // HTTP error: body is never read; request id equal to the key and malformed Retry-After are not retained.
  const http = await ask(config, input, key, async () => new Response(leak, { status: 429, headers: { 'x-typesafe-request-id': key, 'retry-after': `${key}` } })).catch(e => e);
  const hd = failureDiagnostics(http, key);
  assert.equal(http.message, 'JEV_HTTP_429'); assert.equal(hd.stage, 'http'); assert.equal(hd.httpStatus, 429);
  assert.equal(hd.requestId, 'redacted'); assert.equal(hd.retryAfter, 'invalid');
  const retry = failureDiagnostics(await ask(config, input, key, async () => new Response('', { status: 503, headers: { 'retry-after': '30' } })).catch(e => e), key);
  assert.equal(retry.retryAfter, '30');
  // Validation failure whose reply echoes the key and prose in every string slot.
  const questions = { route: { type: 'choice', instructions: 'Select', criteria: { a: 'A', b: 'B' } } };
  const hostile = { model: key, error: leak, answers: { route: { type: 'choice', choice: leak, probabilities: { a: 0.2, b: 0.2, [leak]: 'x' }, confidence: 0.1 }, [leak]: { type: 'noul', noul: 1 } }, usage: { input_tokens: leak } };
  const vd = failureDiagnostics(await ask(config, { ...input, questions }, key, async () => Response.json(hostile, { headers: { 'x-typesafe-request-id': 'has spaces and ' + leak } })).catch(e => e), key);
  assert.equal(vd.stage, 'validate'); assert.equal(vd.servedModel, 'redacted'); assert.equal(vd.requestId, 'invalid'); assert.equal(vd.usage, 'invalid');
  assert.deepEqual(vd.answerKeys, { expected: 1, received: 2 });
  assert.equal(vd.distributions[0].nonNumeric, 1); assert.equal(vd.distributions[0].keysMatch, false);
  // Parse failure: SyntaxError message (which quotes the body) is never kept.
  const pd = failureDiagnostics(await ask(config, input, key, async () => new Response(`{"x": "${leak}"`)).catch(e => e), key);
  assert.equal(pd.stage, 'parse'); assert.equal(pd.errorName, 'SyntaxError');
  // Transport failure: only the allowlisted error name survives.
  const td = failureDiagnostics(await ask(config, input, key, async () => { const e = new Error(leak); e.name = leak; throw e; }).catch(e => e), key);
  assert.equal(td.stage, 'transport'); assert.equal(td.errorName, 'other');
  // A caller cannot widen the allowlist by attaching extra fields.
  const widened = failureDiagnostics({ diagnostics: { stage: 'validate', body: leak, headers: { authorization: key }, requestId: 'ok-id', distributions: [{ questionId: leak, present: true }] } }, key);
  assert.deepEqual(Object.keys(widened).sort(), ['distributions', 'requestId', 'schemaVersion', 'stage']);
  assert.deepEqual(widened.distributions, []);
  for (const diagnostics of [hd, retry, vd, pd, td, widened]) {
    const encoded = JSON.stringify(diagnostics);
    assert.ok(!encoded.includes(key)); assert.ok(!encoded.includes('secret-error-body')); assert.ok(!encoded.includes('stack trace'));
  }
});
