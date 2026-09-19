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

export function validateResponse(response, questions) {
  check(object(response) && text(response.model) && object(response.answers) && sameKeys(response.answers, questions), 'JEV_RESPONSE');
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
    check(object(a.probabilities) && sameKeys(a.probabilities, criteria) && Object.values(a.probabilities).every(probability), 'JEV_DISTRIBUTION');
    check(Math.abs(Object.values(a.probabilities).reduce((sum, p) => sum + p, 0) - 1) < 0.001 && probability(a.confidence), 'JEV_DISTRIBUTION');
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
  check(object(response.usage) && ['input_tokens', 'output_tokens'].every(k => Number.isSafeInteger(response.usage[k]) && response.usage[k] >= 0), 'JEV_USAGE');
  return { model: response.model, answers, usage: { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens } };
}

export async function readCredential(config, env = process.env) {
  let value = env[config.credentialEnv];
  const configuredPath = env[config.credentialFileEnv] || config.credentialFile;
  if (!value && configuredPath) {
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

async function boundedBody(response, limit) {
  check(response.body !== null, 'JEV_RESPONSE');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    check(size <= limit, 'JEV_RESPONSE_TOO_LARGE');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
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
  const response = await transport(config.endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(config.timeoutMs), headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`JEV_HTTP_${response.status}`);
  }
  const result = validateResponse(await boundedBody(response, config.maxResponseBytes), input.questions);
  check(!JSON.stringify(result).includes(key), 'JEV_SECRET_IN_RESPONSE');
  return { schemaVersion: 1, advisoryOnly: true, acceptance: 'not-assessed', requestedModel: config.model, ...result, requestSha256: createHash('sha256').update(body).digest('hex'), measuredAt: new Date().toISOString(), latencyMs: Math.round(performance.now() - start) };
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
    process.stderr.write(JSON.stringify({ schemaVersion: 1, advisoryOnly: true, error: code }) + '\n');
    process.exitCode = 1;
  });
}
