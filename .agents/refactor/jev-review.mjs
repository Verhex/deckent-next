import { open, readFile, realpath } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { ask, readCredential, validateConfig, validateInput, failureDiagnostics } from './jev.mjs';
import { ensure, prepare, validateReviewConfig, validateFollowup } from './jev-context.mjs';
import { callId, validateCallId, safeData, privateDirectory, writeEvent, readEvent } from './jev-journal.mjs';
import { report, pendingOutcomes, DEFAULT_SCAN_LIMIT } from './jev-report.mjs';
import { resolveLineage } from './jev-lineage.mjs';
export { report } from './jev-report.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const errorCode = e => /^JEV_[A-Z0-9_]+$/.test(e.message) ? e.message : 'JEV_REQUEST_FAILED';
async function readStdin(limit) {
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length; ensure(size <= limit, 'JEV_INPUT_SIZE'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function readInput(path, limit) {
  if (path === '-') return readStdin(limit);
  const h = await open(path, 'r');
  try { const stat = await h.stat(); ensure(stat.isFile() && stat.size <= limit, 'JEV_INPUT_SIZE'); return JSON.parse(await h.readFile('utf8')); }
  finally { await h.close(); }
}
export async function consult(config, policy, authoredCase, root, key, transport, meta = {}) {
  const requestAt = new Date().toISOString();
  let prepared = prepare(authoredCase, policy, requestAt);
  // The non-gating shadow question must never make a case unaskable: drop it, recorded, if the wire is too large.
  if (prepared.diagnostics.shadow?.included && Buffer.byteLength(JSON.stringify({ model: config.model, state: prepared.input.state, questions: prepared.input.questions })) > config.maxRequestBytes) {
    prepared = prepare(authoredCase, policy, requestAt, { shadow: false, shadowOmittedReason: 'request-size' });
  }
  return consultPrepared(config, policy, { authoredCase, prepared, requestAt }, root, key, transport, meta);
}
// Shared by consult and evaluation replay. `inputSource` says whether the questions were compiled now
// or replayed byte-for-byte from a stored request (whose templates and charter then govern).
export async function consultPrepared(config, policy, { authoredCase, prepared, requestAt, inputSource = 'prepared' }, root, key, transport, meta = {}) {
  validateInput(prepared.input);
  safeData(prepared, key);
  const wire = { model: config.model, state: prepared.input.state, questions: prepared.input.questions };
  ensure(Buffer.byteLength(JSON.stringify(wire)) <= config.maxRequestBytes, 'JEV_REQUEST_TOO_LARGE');
  const id = callId(); const requestSha256 = digest(wire);
  // Lineage is validated (parent read-only) before any journal write or network work.
  const lineage = await resolveLineage(meta, { root, id, requestSha256, reviewPolicy: policy.reviewPolicy });
  const versions = { schemaVersion: 1, reviewConfigSchemaVersion: policy.schemaVersion, reviewConfigSha256: digest(policy),
    providerConfigSha256: digest(config), templates: prepared.diagnostics?.templates ?? 'unknown', reviewPolicy: policy.reviewPolicy ?? null, inputSource };
  const directory = join(await privateDirectory(root), id);
  const request = { schemaVersion: 2, callId: id, at: requestAt, case: authoredCase, ...prepared, endpoint: config.endpoint, requestedModel: config.model, policySha256: versions.reviewConfigSha256, requestSha256, lineage, versions };
  await writeEvent(directory, 'request.json', request, key);
  const start = performance.now();
  let response;
  try { response = await ask(config, prepared.input, key, transport); }
  catch (e) {
    const failure = { schemaVersion: 2, callId: id, at: new Date().toISOString(), error: errorCode(e), latencyMs: Math.round(performance.now() - start), usage: 'unknown', rawResponseRetained: false };
    const diagnostics = failureDiagnostics(e, key);
    try { await writeEvent(directory, 'failure.json', { ...failure, diagnostics }, key); }
    catch (journal) {
      // Diagnostics must never cost the failure record itself.
      if (journal.message !== 'JEV_SECRET_IN_JOURNAL') throw journal;
      await writeEvent(directory, 'failure.json', { ...failure, diagnostics: { schemaVersion: 1, stage: diagnostics.stage, withheld: 'secret-containment' } }, key);
    }
    return { callId: id, directory, status: 'unavailable', error: errorCode(e), stage: diagnostics.stage, lineage, advisoryOnly: true };
  }
  await writeEvent(directory, 'response.json', { ...response, callId: id }, key);
  return { callId: id, directory, status: 'advice', ...response, lineage };
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
// Lineage flags for ask: --relation new-decision|context-revision|transport-retry, --parent CALL_ID,
// --case-id ID, --reason TEXT, --purpose development|evaluation|control|pilot.
const LINEAGE_FLAGS = { '--relation': 'relation', '--parent': 'parentCallId', '--case-id': 'caseId', '--reason': 'reason', '--purpose': 'purpose' };
export function parseArgs(args) {
  const positional = []; const meta = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) { positional.push(args[i]); continue; }
    const field = LINEAGE_FLAGS[args[i]];
    ensure(field && !Object.hasOwn(meta, field) && i + 1 < args.length, 'JEV_REVIEW_USAGE');
    meta[field] = args[++i];
  }
  return { positional, meta };
}
async function main(argv) {
  const { positional: args, meta } = parseArgs(argv);
  const [mode, first, second, ...extra] = args;
  ensure(['prepare', 'ask', 'decision', 'outcome', 'report', 'pending'].includes(mode) && extra.length === 0, 'JEV_REVIEW_USAGE');
  ensure(mode === 'ask' || Object.keys(meta).length === 0, 'JEV_REVIEW_USAGE');
  ensure(['report', 'pending'].includes(mode) ? !second && (first === undefined || /^[1-9][0-9]{0,5}$/.test(first)) : ['decision', 'outcome'].includes(mode) ? first && second : first && !second, 'JEV_REVIEW_USAGE');
  const policyPath = process.env.DECKENT_JEV_REVIEW_CONFIG || join(here, 'jev.review.config.json');
  const policy = validateReviewConfig(JSON.parse(await readFile(policyPath, 'utf8')));
  const root = resolve(dirname(resolve(policyPath)), policy.journalRoot);
  if (mode === 'report' || mode === 'pending') {
    // Read-only: no credential, no network, no journal directory creation.
    const limit = first === undefined ? policy.reportLimit : Number(first);
    ensure(limit <= policy.reportLimit, 'JEV_REPORT_LIMIT');
    const options = { scanLimit: policy.reportScanLimit ?? Math.max(DEFAULT_SCAN_LIMIT, policy.reportLimit), reviewPolicy: policy.reviewPolicy, pricing: policy.pricing };
    return mode === 'report' ? report(root, limit, options) : pendingOutcomes(root, limit, options);
  }
  const value = await readInput(['decision', 'outcome'].includes(mode) ? second : first, policy.maxCaseBytes);
  if (mode === 'prepare') return { network: false, ...prepare(value, policy), authoringGuidance: policy.authoringGuidance ?? null };
  const config = validateConfig(JSON.parse(await readFile(process.env.DECKENT_JEV_CONFIG || join(here, 'jev.config.json'), 'utf8')));
  const key = await readCredential(config);
  if (mode === 'ask') return consult(config, policy, value, root, key, undefined, meta);
  return followup(root, first, mode, value, key);
}
if (process.argv[1] && await realpath(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(result => {
    process.stdout.write(JSON.stringify(result) + '\n');
    if (result.status === 'unavailable') process.exitCode = 1;
  }).catch(e => { process.stderr.write(JSON.stringify({ error: errorCode(e), advisoryOnly: true }) + '\n'); process.exitCode = 1; });
}
