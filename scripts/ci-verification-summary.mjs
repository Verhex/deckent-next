import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Collected outcomes only: a failed preparation/lint/build never becomes zero failing tests.
export function verificationSummary(log, outcome, identity = {}) {
  const records = { evidence: [], failedTests: [], notRun: [], contexts: [] };
  for (const line of log.split(/\r?\n/u)) {
    const hostFailure = /^\s*not ok \d+ - (.+)$/u.exec(line);
    if (hostFailure) records.failedTests.push({ file: null, test: hostFailure[1], state: 'failed', runner: 'node-test' });
    const hostSkip = /^\s*ok \d+ - (.+?) # SKIP(?: (.+))?$/u.exec(line);
    if (hostSkip) records.notRun.push({ file: null, test: hostSkip[1], state: 'skipped', runner: 'node-test',
      reason: hostSkip[2] ?? 'not-reported-by-test; do-not-infer-platform-or-env-cause' });
    const match = /^(verify-evidence|verify-failed-test|verify-not-run|verify-context): (.+)$/u.exec(line.replace(/^\s*#\s?/u, ''));
    if (!match) continue;
    const key = { 'verify-evidence': 'evidence', 'verify-failed-test': 'failedTests',
      'verify-not-run': 'notRun', 'verify-context': 'contexts' }[match[1]];
    records[key].push(JSON.parse(match[2]));
  }
  const evidence = records.evidence.at(-1) ?? null;
  return { schemaVersion: 1, identity, verifyStepOutcome: outcome || 'not-started',
    collection: evidence ? 'reported' : 'not-reported',
    reason: evidence ? null : 'VERIFY_OUTCOMES_UNAVAILABLE: verify did not report completed Vitest outcomes',
    evidence, contexts: records.contexts, failedTests: records.failedTests, notRun: records.notRun };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = resolve('.pack/ci-evidence');
  mkdirSync(directory, { recursive: true });
  let log = '';
  try { log = readFileSync(join(directory, 'verify.log'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const summary = verificationSummary(log, process.env.DECKENT_CI_VERIFY_OUTCOME, {
    sha: process.env.GITHUB_SHA ?? null, ref: process.env.GITHUB_REF ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null, attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    platform: process.platform, node: process.version,
  });
  summary.preparation = Object.fromEntries(Object.entries({ temporaryParent: 'DECKENT_CI_TEMP_OUTCOME',
    npmCi: 'DECKENT_CI_INSTALL_OUTCOME', dockerFixture: 'DECKENT_CI_DOCKER_OUTCOME',
    bubblewrap: 'DECKENT_CI_BWRAP_OUTCOME', shellRealm: 'DECKENT_CI_REALM_OUTCOME' })
    .map(([step, key]) => [step, process.env[key] || 'not-started']));
  for (const [file, value] of Object.entries({ 'verify-evidence.json': summary,
    'failed-tests.json': { collection: summary.collection, tests: summary.failedTests },
    'verify-not-run.json': summary.notRun })) {
    writeFileSync(join(directory, file), JSON.stringify(value, null, 2) + '\n');
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `Verification: ${summary.verifyStepOutcome}; collected outcomes: ${summary.collection}.\n\n` +
      `Failed tests/collection errors: ${summary.failedTests.length}; visible not-run records: ${summary.notRun.length}.\n\n` +
      `Preparation outcomes: ${JSON.stringify(summary.preparation)}.\n\n` +
      'Download this job\'s verify artifact for JSON outcomes, failed-test names, skip reasons and the original log.\n');
  }
  // A green verify without a reporter receipt is a broken evidence pipeline.
  if (summary.verifyStepOutcome === 'success' && (!summary.evidence || summary.evidence.counts.failed > 0
    || summary.evidence.collectionErrors > 0 || summary.evidence.unhandledErrors > 0)) {
    throw new Error('CI_VERIFICATION_EVIDENCE_INVALID');
  }
}
