import { open, readFile, realpath } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { ask, readCredential, validateConfig } from './jev.mjs';
import { ensure, prepare, validateReviewConfig, validateFollowup } from './jev-context.mjs';
import { callId, validateCallId, safeData, privateDirectory, writeEvent, readEvent } from './jev-journal.mjs';
import { report, DEFAULT_SCAN_LIMIT } from './jev-report.mjs';
export { report } from './jev-report.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const errorCode = e => /^JEV_[A-Z0-9_]+$/.test(e.message) ? e.message : 'JEV_REQUEST_FAILED';
async function readInput(path, limit) {
  const h = await open(path, 'r');
  try { const stat = await h.stat(); ensure(stat.isFile() && stat.size <= limit, 'JEV_INPUT_SIZE'); return JSON.parse(await h.readFile('utf8')); }
  finally { await h.close(); }
}
export async function consult(config, policy, authoredCase, root, key, transport) {
  const requestAt = new Date().toISOString();
  const prepared = prepare(authoredCase, policy, requestAt);
  safeData(prepared, key);
  const wire = { model: config.model, state: prepared.input.state, questions: prepared.input.questions };
  ensure(Buffer.byteLength(JSON.stringify(wire)) <= config.maxRequestBytes, 'JEV_REQUEST_TOO_LARGE');
  const id = callId(); const directory = join(await privateDirectory(root), id);
  const request = { schemaVersion: 1, callId: id, at: requestAt, case: authoredCase, ...prepared, endpoint: config.endpoint, requestedModel: config.model, policySha256: digest(policy), requestSha256: digest(wire) };
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
async function main(args) {
  const [mode, first, second, ...extra] = args;
  ensure(['prepare', 'ask', 'decision', 'outcome', 'report'].includes(mode) && extra.length === 0, 'JEV_REVIEW_USAGE');
  ensure(mode === 'report' ? !second && (first === undefined || /^[1-9][0-9]{0,5}$/.test(first)) : ['decision', 'outcome'].includes(mode) ? first && second : first && !second, 'JEV_REVIEW_USAGE');
  const policyPath = process.env.DECKENT_JEV_REVIEW_CONFIG || join(here, 'jev.review.config.json');
  const policy = validateReviewConfig(JSON.parse(await readFile(policyPath, 'utf8')));
  const root = resolve(dirname(resolve(policyPath)), policy.journalRoot);
  if (mode === 'report') {
    const limit = first === undefined ? policy.reportLimit : Number(first);
    ensure(limit <= policy.reportLimit, 'JEV_REPORT_LIMIT');
    return report(root, limit, { scanLimit: policy.reportScanLimit ?? Math.max(DEFAULT_SCAN_LIMIT, policy.reportLimit) });
  }
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
