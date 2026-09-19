import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, chmod, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ask, readCredential, validateInput, validateResponse } from './jev.mjs';
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
test('credentials require private regular owner file; symlinks and broad permissions fail', async () => {
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
