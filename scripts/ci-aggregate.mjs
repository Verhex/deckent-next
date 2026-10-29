import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { durationDrift, observedDurations, validateShards } from './ci-test-plan.mjs';
import { driftReport } from './ci-test-weights.mjs';
const root = process.cwd();
const inventory = JSON.parse(readFileSync('.pack/ci-inventory.json', 'utf8')).map(row => relative(root, row.file).replaceAll('\\', '/'));
const receiptRoot = process.argv[2];
if (!receiptRoot) throw new Error('Receipt directory required');
const receipts = readdirSync(receiptRoot).map(directory => JSON.parse(readFileSync(join(receiptRoot, directory, 'receipt.json'), 'utf8')));
const result = validateShards(inventory, receipts, { sha: process.env.GITHUB_SHA, node: process.versions.node.split('.')[0],
  runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT });
console.log(`Whole-suite evidence: ${JSON.stringify(result)}`);
// Weight drift is a visible warning, not a failure: weights come from hosted runs, so a new heavy file cannot be weighted before its first run.
const durations = JSON.parse(readFileSync(new URL('./ci-test-durations.json', import.meta.url), 'utf8')).durationMs;
const drift = durationDrift(inventory, observedDurations(receipts), durations);
for (const line of driftReport(drift)) console.log(`::warning file=scripts/ci-test-durations.json,title=CI duration weight drift::${line}`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
  `Duration weight drift: ${drift.drifted ? 'yes, see the warnings' : 'none'} (${drift.slow.length} slow, ${drift.unweighted.length} unweighted).\n`);
