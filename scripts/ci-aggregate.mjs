import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { validateShards } from './ci-test-plan.mjs';
const root = process.cwd();
const inventory = JSON.parse(readFileSync('.pack/ci-inventory.json', 'utf8')).map(row => relative(root, row.file).replaceAll('\\', '/'));
const receiptRoot = process.argv[2];
if (!receiptRoot) throw new Error('Receipt directory required');
const receipts = readdirSync(receiptRoot).map(directory => JSON.parse(readFileSync(join(receiptRoot, directory, 'receipt.json'), 'utf8')));
const result = validateShards(inventory, receipts, { sha: process.env.GITHUB_SHA, node: process.versions.node.split('.')[0],
  runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT });
console.log(`Whole-suite evidence: ${JSON.stringify(result)}`);
