import { open, readFile, realpath } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { ask, readCredential, validateConfig } from './jev.mjs';
import { ensure, prepare, validateReviewConfig, validateFollowup } from './jev-context.mjs';
import { callId, validateCallId, safeData, privateDirectory, writeEvent, readEvent, entries } from './jev-journal.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const errorCode = e => /^JEV_[A-Z0-9_]+$/.test(e.message) ? e.message : 'JEV_REQUEST_FAILED';
async function readInput(path, limit) {
  const h = await open(path, 'r');
  try { const stat = await h.stat(); ensure(stat.isFile() && stat.size <= limit, 'JEV_INPUT_SIZE'); return JSON.parse(await h.readFile('utf8')); }
  finally { await h.close(); }
}
async function optional(directory, name) {
  try { return await readEvent(directory, name); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
export async function consult(config, policy, authoredCase, root, key, transport) {
  const prepared = prepare(authoredCase, policy);
  safeData(authoredCase, key);
  const wire = { model: config.model, state: prepared.input.state, questions: prepared.input.questions };
  ensure(Buffer.byteLength(JSON.stringify(wire)) <= config.maxRequestBytes, 'JEV_REQUEST_TOO_LARGE');
  const id = callId(); const directory = join(await privateDirectory(root), id);
  const request = { schemaVersion: 1, callId: id, at: new Date().toISOString(), case: authoredCase, ...prepared, endpoint: config.endpoint, requestedModel: config.model, policySha256: digest(policy), requestSha256: digest(wire) };
  await writeEvent(directory, 'request.json', request, key);
  const start = performance.now();
  let response;
  try { response = await ask(config, prepared.input, key, transport); }
  catch (e) {
    await writeEvent(directory, 'failure.json', { schemaVersion: 1, callId: id, at: new Date().toISOString(), error: errorCode(e), latencyMs: Math.round(performance.now() - start), usage: 'unknown', rawResponseRetained: false }, key);
    return { callId: id, directory, status: 'unavailable', error: errorCode(e), advisoryOnly: true };
  }
  await writeEvent(directory, 'response.json', { ...response, callId: id }, key);
  return { callId: id, directory, status: 'advice', ...response };
}
export async function followup(root, id, type, value, key) {
  validateCallId(id);
  const directory = join(root, id);
  const request = await readEvent(directory, 'request.json');
  validateFollowup(value, type, request);
  if (type === 'outcome') await readEvent(directory, 'decision.json');
  await writeEvent(directory, `${type}.json`, { schemaVersion: 1, callId: id, at: new Date().toISOString(), ...value }, key);
  return { callId: id, recorded: type };
}
export async function report(root, limit) {
  const listing = await entries(root, limit);
  const rows = []; let inputTokens = 0; let outputTokens = 0; let brierSum = 0; let labels = 0;
  for (const id of listing.ids) {
    const directory = join(root, id);
    const request = await readEvent(directory, 'request.json');
    const response = await optional(directory, 'response.json');
    const failure = await optional(directory, 'failure.json');
    const decision = await optional(directory, 'decision.json');
    const outcome = await optional(directory, 'outcome.json');
    if (response) {
      inputTokens += response.usage.input_tokens; outputTokens += response.usage.output_tokens;
      for (const label of outcome?.labels || []) {
        const p = response.answers[label.questionId]?.noul;
        if (Number.isFinite(p)) { brierSum += (p - Number(label.expected)) ** 2; labels++; }
      }
    }
    rows.push({ callId: id, scope: request.case.scope, revision: request.case.revision, status: response ? 'advice' : failure ? 'unavailable' : 'response-unknown', model: response?.model ?? null, latencyMs: response?.latencyMs ?? failure?.latencyMs ?? null, selectedOption: decision?.selectedOption ?? null, recommendation: response?.answers.next_action?.choice ?? null, agreement: response && decision ? response.answers.next_action.choice === decision.selectedOption : null, outcome: outcome?.status ?? 'unobserved', inputQuality: outcome?.inputQuality ?? null, outputQuality: outcome?.outputQuality ?? null });
  }
  const times = rows.filter(r => r.latencyMs !== null).map(r => r.latencyMs).sort((a, b) => a - b);
  return { schemaVersion: 1, measuredAt: new Date().toISOString(), sampledCalls: rows.length, truncated: listing.truncated, selection: 'bounded directory enumeration, not a latest-call window', usage: { inputTokens, outputTokens, excludesFailedAndUnrecordedUsage: true }, latency: { samples: times.length, p50Ms: times.length ? times[Math.ceil(times.length * 0.5) - 1] : null, p95Ms: times.length ? times[Math.ceil(times.length * 0.95) - 1] : null }, quality: { labeledNoulAnswers: labels, brierScore: labels ? brierSum / labels : null, basis: 'operator-provided evidence-backed labels; not independently verified or a representative benchmark', agreementIsCorrectness: false }, rows };
}
async function main(args) {
  const [mode, first, second, ...extra] = args;
  ensure(['prepare', 'ask', 'decision', 'outcome', 'report'].includes(mode) && extra.length === 0, 'JEV_REVIEW_USAGE');
  ensure(mode === 'report' ? !first && !second : ['decision', 'outcome'].includes(mode) ? first && second : first && !second, 'JEV_REVIEW_USAGE');
  const policyPath = process.env.DECKENT_JEV_REVIEW_CONFIG || join(here, 'jev.review.config.json');
  const policy = validateReviewConfig(JSON.parse(await readFile(policyPath, 'utf8')));
  const root = resolve(dirname(resolve(policyPath)), policy.journalRoot);
  if (mode === 'report') return report(root, policy.reportLimit);
  const value = await readInput(['decision', 'outcome'].includes(mode) ? second : first, policy.maxCaseBytes);
  if (mode === 'prepare') return { network: false, ...prepare(value, policy) };
  const config = validateConfig(JSON.parse(await readFile(process.env.DECKENT_JEV_CONFIG || join(here, 'jev.config.json'), 'utf8')));
  const key = await readCredential(config);
  if (mode === 'ask') return consult(config, policy, value, root, key);
  return followup(root, first, mode, value, key);
}
if (process.argv[1] && await realpath(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(result => {
    process.stdout.write(JSON.stringify(result) + '\n');
    if (result.status === 'unavailable') process.exitCode = 1;
  }).catch(e => { process.stderr.write(JSON.stringify({ error: errorCode(e), advisoryOnly: true }) + '\n'); process.exitCode = 1; });
}
