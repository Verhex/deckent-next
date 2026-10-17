// Development host only. Never imported by the product or used as an approval authority.
import { readFile, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const probability = v => Number.isFinite(v) && v >= 0 && v <= 1;
const check = (ok, code) => { if (!ok) throw new Error(code); };
const exact = (v, keys) => object(v) && Object.keys(v).every(k => keys.includes(k));
const sameKeys = (a, b) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => Object.hasOwn(b, k));
const text = v => typeof v === 'string' && v.trim().length > 0;

export function validateConfig(c) {
  check(exact(c, ['schemaVersion', 'endpoint', 'model', 'credentialEnv', 'credentialFileEnv', 'credentialFile', 'timeoutMs', 'maxRequestBytes', 'maxResponseBytes']) && c.schemaVersion === 1, 'JEV_CONFIG');
  check(c.credentialFile === undefined || text(c.credentialFile), 'JEV_CONFIG');
  const url = new URL(c.endpoint);
  check(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash, 'JEV_ENDPOINT');
  check(text(c.model) && /^[A-Z][A-Z0-9_]*$/.test(c.credentialEnv) && /^[A-Z][A-Z0-9_]*$/.test(c.credentialFileEnv), 'JEV_CONFIG');
  for (const k of ['timeoutMs', 'maxRequestBytes', 'maxResponseBytes']) check(Number.isSafeInteger(c[k]) && c[k] > 0 && c[k] <= 2147483647, 'JEV_CONFIG');
  return c;
}

export function validateInput(input) {
  check(exact(input, ['schemaVersion', 'state', 'questions']) && input.schemaVersion === 1, 'JEV_INPUT');
  check(typeof input.state === 'string' || object(input.state) || Array.isArray(input.state), 'JEV_STATE');
  check(object(input.questions) && Object.keys(input.questions).length > 0, 'JEV_QUESTIONS');
  for (const q of Object.values(input.questions)) {
    check(exact(q, ['type', 'instructions', 'criteria']) && (text(q.instructions) || object(q.instructions) || Array.isArray(q.instructions)), 'JEV_QUESTION');
    if (q.type === 'noul') {
      check(q.criteria === undefined || (exact(q.criteria, ['true', 'false']) && Object.values(q.criteria).every(text)), 'JEV_CRITERIA');
    } else if (q.type === 'choice') {
      check(object(q.criteria) && Object.keys(q.criteria).length >= 2 && Object.values(q.criteria).every(v => v === null || text(v)), 'JEV_CRITERIA');
    } else if (q.type === 'score') {
      check(Array.isArray(q.criteria) && q.criteria.length >= 2 && q.criteria.every(text), 'JEV_CRITERIA');
    } else throw new Error('JEV_QUESTION_TYPE');
  }
  return input;
}

// Metering is independent of advice validity: a null or missing count is 'unknown', never zero.
// Present counts must be safe nonnegative integers; any other value still rejects the reply.
export function normalizeUsage(usage) {
  if (usage === undefined || usage === null) return { input_tokens: 'unknown', output_tokens: 'unknown' };
  check(object(usage), 'JEV_USAGE');
  const count = k => {
    const v = usage[k];
    if (v === undefined || v === null) return 'unknown';
    check(Number.isSafeInteger(v) && v >= 0, 'JEV_USAGE');
    return v;
  };
  return { input_tokens: count('input_tokens'), output_tokens: count('output_tokens') };
}

export function validateResponse(response, questions) {
  check(object(response) && text(response.model) && object(response.answers) && sameKeys(response.answers, questions), 'JEV_RESPONSE');
  const usage = normalizeUsage(response.usage);
  const answers = {};
  for (const [id, q] of Object.entries(questions)) {
    const a = response.answers[id];
    check(object(a) && a.type === q.type, 'JEV_ANSWER');
    if (q.type === 'noul') {
      check(probability(a.noul), 'JEV_ANSWER');
      Object.defineProperty(answers, id, { value: { type: a.type, noul: a.noul }, enumerable: true });
      continue;
    }
    const criteria = q.type === 'choice' ? q.criteria : Object.fromEntries(q.criteria.map((v, i) => [String(i), v]));
    check(object(a.probabilities) && sameKeys(a.probabilities, criteria), 'JEV_DISTRIBUTION_KEYS');
    check(Object.values(a.probabilities).every(probability), 'JEV_DISTRIBUTION_RANGE');
    check(Math.abs(Object.values(a.probabilities).reduce((sum, p) => sum + p, 0) - 1) < 0.001, 'JEV_DISTRIBUTION_SUM');
    check(probability(a.confidence), 'JEV_DISTRIBUTION_CONFIDENCE');
    const normalized = { type: a.type, probabilities: a.probabilities, confidence: a.confidence };
    if (q.type === 'choice') {
      check(typeof a.choice === 'string' && Object.hasOwn(criteria, a.choice), 'JEV_ANSWER');
      normalized.choice = a.choice;
    } else {
      check(Number.isFinite(a.score) && a.score >= 0 && a.score <= q.criteria.length - 1, 'JEV_ANSWER');
      check(object(a.legend) && sameKeys(a.legend, criteria) && Object.keys(criteria).every(k => a.legend[k] === criteria[k]), 'JEV_ANSWER');
      normalized.score = a.score;
      normalized.legend = a.legend;
    }
    Object.defineProperty(answers, id, { value: normalized, enumerable: true });
  }
  return { model: response.model, answers, usage };
}

export async function readCredential(config, env = process.env) {
  let value = env[config.credentialEnv];
  const configuredPath = env[config.credentialFileEnv] || config.credentialFile;
  if (!value && configuredPath) {
    check(process.platform !== 'win32' && typeof process.getuid === 'function' && constants.O_NOFOLLOW > 0, 'JEV_CREDENTIAL_FILE_UNSUPPORTED');
    const path = configuredPath.startsWith('~/') ? resolve(homedir(), configuredPath.slice(2)) : configuredPath;
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      check(stat.isFile() && (stat.mode & 0o077) === 0 && stat.uid === process.getuid() && stat.size <= 8192, 'JEV_CREDENTIAL_FILE');
      value = (await handle.readFile('utf8')).trim();
    } finally { await handle.close(); }
  }
  check(text(value) && !/\s/.test(value), 'JEV_CREDENTIAL_MISSING');
  return value;
}

async function boundedBytes(response, limit) {
  check(response.body !== null, 'JEV_RESPONSE');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    check(size <= limit, 'JEV_RESPONSE_TOO_LARGE');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// Safe failure diagnostics. Only enumerated stages, numbers and shape-checked provider tokens are kept;
// error bodies, error messages, headers beyond the allowlist and response strings are never retained.
export const DIAGNOSTIC_STAGES = ['request', 'transport', 'http', 'body', 'parse', 'validate', 'secret-echo'];
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SERVED_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const RETRY_AFTER = /^(?:\d{1,7}|[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT)$/;
const ERROR_NAMES = ['TimeoutError', 'AbortError', 'TypeError', 'SyntaxError'];
function token(value, pattern, key) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !pattern.test(value)) return 'invalid';
  // A value carrying the credential, or a long fragment of it, is never retained.
  return key && (value.includes(key) || (value.length >= 8 && key.includes(value))) ? 'redacted' : value;
}
const number = v => Number.isFinite(v) ? v : null;
const count = v => Number.isSafeInteger(v) && v >= 0 ? v : null;
function distributionDiagnostics(parsed, questions) {
  const answers = object(parsed) && object(parsed.answers) ? parsed.answers : {};
  const result = [];
  for (const [questionId, q] of Object.entries(questions)) {
    if (q.type === 'noul') continue;
    const expectedCount = q.type === 'choice' ? Object.keys(q.criteria).length : q.criteria.length;
    const a = Object.hasOwn(answers, questionId) ? answers[questionId] : undefined;
    if (!object(a) || !object(a.probabilities)) { result.push({ questionId, present: false, expectedCount }); continue; }
    const values = Object.values(a.probabilities); const finite = values.filter(Number.isFinite);
    const criteria = q.type === 'choice' ? q.criteria : Object.fromEntries(q.criteria.map((v, i) => [String(i), v]));
    result.push({ questionId, present: true, expectedCount, count: values.length, nonNumeric: values.length - finite.length,
      keysMatch: sameKeys(a.probabilities, criteria), sum: finite.reduce((sum, p) => sum + p, 0),
      min: finite.length ? Math.min(...finite) : null, max: finite.length ? Math.max(...finite) : null });
  }
  return result;
}
function usageDiagnostics(parsed) {
  if (!object(parsed)) return 'unknown';
  try { return normalizeUsage(parsed.usage); } catch { return 'invalid'; }
}
function failWith(error, diagnostics) {
  const e = error instanceof Error ? error : new Error('JEV_REQUEST_FAILED');
  try { e.diagnostics = { schemaVersion: 1, ...diagnostics }; } catch { /* non-extensible error: code alone remains */ }
  return e;
}
// Re-applies the allowlist at the journal boundary so no caller can widen it.
export function failureDiagnostics(error, key) {
  const d = object(error?.diagnostics) ? error.diagnostics : {};
  const stage = DIAGNOSTIC_STAGES.includes(d.stage) ? d.stage : 'unknown';
  const out = { schemaVersion: 1, stage };
  if (Number.isSafeInteger(d.httpStatus) && d.httpStatus >= 100 && d.httpStatus <= 599) out.httpStatus = d.httpStatus;
  for (const [field, pattern] of [['requestId', REQUEST_ID], ['retryAfter', RETRY_AFTER], ['servedModel', SERVED_MODEL]]) {
    if (d[field] !== undefined && d[field] !== null) out[field] = token(d[field], pattern, key);
  }
  if (ERROR_NAMES.includes(d.errorName)) out.errorName = d.errorName; else if (d.errorName !== undefined) out.errorName = 'other';
  if (count(d.responseBytes) !== null) out.responseBytes = d.responseBytes;
  if (typeof d.responseSha256 === 'string' && /^[0-9a-f]{64}$/.test(d.responseSha256)) out.responseSha256 = d.responseSha256;
  if (d.usage === 'unknown' || d.usage === 'invalid') out.usage = d.usage;
  else if (object(d.usage)) out.usage = Object.fromEntries(['input_tokens', 'output_tokens'].map(k => [k, count(d.usage[k]) ?? 'unknown']));
  if (object(d.answerKeys)) out.answerKeys = { expected: count(d.answerKeys.expected), received: count(d.answerKeys.received) };
  if (Array.isArray(d.distributions)) {
    out.distributions = d.distributions.filter(x => object(x) && typeof x.questionId === 'string' && REQUEST_ID.test(x.questionId)).map(x => ({
      questionId: token(x.questionId, REQUEST_ID, key), present: x.present === true, expectedCount: count(x.expectedCount),
      ...(x.present === true ? { count: count(x.count), nonNumeric: count(x.nonNumeric), keysMatch: x.keysMatch === true,
        sum: number(x.sum), min: number(x.min), max: number(x.max) } : {}) }));
  }
  return out;
}

export async function ask(config, input, key, transport = fetch) {
  validateConfig(config);
  validateInput(input);
  check(text(key) && !/\s/.test(key), 'JEV_CREDENTIAL_MISSING');
  const body = JSON.stringify({ model: config.model, state: input.state, questions: input.questions });
  check(Buffer.byteLength(body) <= config.maxRequestBytes, 'JEV_REQUEST_TOO_LARGE');
  check(!body.includes(key), 'JEV_SECRET_IN_PAYLOAD');
  const start = performance.now();
  // One request per invocation: no hidden retries, cost multiplication or redirect credential forwarding.
  let response;
  try {
    response = await transport(config.endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(config.timeoutMs), headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body });
  } catch (e) { throw failWith(e, { stage: 'transport', errorName: e?.name }); }
  const header = name => typeof response.headers?.get === 'function' ? response.headers.get(name) : null;
  const provider = { httpStatus: response.status, requestId: token(header('x-typesafe-request-id'), REQUEST_ID, key) };
  if (!response.ok) {
    await response.body?.cancel();
    throw failWith(new Error(`JEV_HTTP_${response.status}`), { stage: 'http', ...provider, retryAfter: token(header('retry-after'), RETRY_AFTER, key) });
  }
  let bytes;
  try { bytes = await boundedBytes(response, config.maxResponseBytes); }
  catch (e) { throw failWith(e, { stage: 'body', ...provider, errorName: e?.name }); }
  const received = { ...provider, responseBytes: bytes.length, responseSha256: createHash('sha256').update(bytes).digest('hex') };
  let parsed;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch (e) { throw failWith(e, { stage: 'parse', ...received, errorName: e?.name }); }
  let result;
  try { result = validateResponse(parsed, input.questions); }
  catch (e) {
    // Captured before the rejected reply is discarded; the distribution-sum rule itself is unchanged.
    throw failWith(e, { stage: 'validate', ...received, servedModel: token(object(parsed) ? parsed.model : null, SERVED_MODEL, key),
      usage: usageDiagnostics(parsed), answerKeys: { expected: Object.keys(input.questions).length, received: object(parsed) && object(parsed.answers) ? Object.keys(parsed.answers).length : 0 },
      distributions: distributionDiagnostics(parsed, input.questions) });
  }
  if (JSON.stringify(result).includes(key)) throw failWith(new Error('JEV_SECRET_IN_RESPONSE'), { stage: 'secret-echo', ...received, usage: result.usage });
  return { schemaVersion: 1, advisoryOnly: true, acceptance: 'not-assessed', requestedModel: config.model, ...result, providerRequestId: provider.requestId, requestSha256: createHash('sha256').update(body).digest('hex'), measuredAt: new Date().toISOString(), latencyMs: Math.round(performance.now() - start) };
}

async function main(args) {
  const [mode, inputPath, configPath, ...extra] = args;
  check(['check', 'ask'].includes(mode) && inputPath && extra.length === 0, 'JEV_USAGE: node .agents/refactor/jev.mjs check|ask input.json [config.json]');
  const config = validateConfig(JSON.parse(await readFile(configPath || new URL('./jev.config.json', import.meta.url), 'utf8')));
  const inputFile = await open(inputPath, 'r');
  let input;
  try {
    const stat = await inputFile.stat();
    check(stat.isFile() && stat.size <= config.maxRequestBytes, 'JEV_REQUEST_TOO_LARGE');
    input = validateInput(JSON.parse(await inputFile.readFile('utf8')));
  } finally { await inputFile.close(); }
  if (mode === 'check') {
    process.stdout.write(JSON.stringify({ schemaVersion: 1, valid: true, network: false, endpoint: config.endpoint, model: config.model, questionCount: Object.keys(input.questions).length }) + '\n');
    return;
  }
  const key = await readCredential(config);
  process.stdout.write(JSON.stringify(await ask(config, input, key)) + '\n');
}

if (process.argv[1] && await realpath(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    // Never print fetch errors, response bodies, paths, payloads, or credentials.
    const code = /^JEV_[A-Z0-9_]+$/.test(error.message) ? error.message : 'JEV_REQUEST_FAILED';
    process.stderr.write(JSON.stringify({ schemaVersion: 1, advisoryOnly: true, error: code, stage: failureDiagnostics(error).stage }) + '\n');
    process.exitCode = 1;
  });
}
