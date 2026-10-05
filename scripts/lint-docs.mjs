#!/usr/bin/env node
// Permanent size guard for the single-source-of-truth documents (owner 2026-10-05): PLAN.md stays a short
// working document; detail lives in .deckent/docs/. Limits are deliberately loose guard rails, not targets.
import { readFileSync } from 'node:fs';
const ROOT = new URL('..', import.meta.url).pathname;
const LIMITS = { planBytes: 60 * 1024, planLineChars: 800, architectureLines: 1200 };
const read = (name) => readFileSync(ROOT + name, 'utf8');
const failures = [];
const plan = read('PLAN.md');
const planBytes = Buffer.byteLength(plan);
if (planBytes > LIMITS.planBytes) failures.push(`PLAN.md is ${planBytes} bytes > ${LIMITS.planBytes}`);
plan.split('\n').forEach((line, index) => { if (line.length > LIMITS.planLineChars) failures.push(`PLAN.md:${index + 1} line has ${line.length} chars > ${LIMITS.planLineChars}`); });
const architectureLines = read('ARCHITECTURE.md').trimEnd().split('\n').length;
if (architectureLines > LIMITS.architectureLines) failures.push(`ARCHITECTURE.md has ${architectureLines} lines > ${LIMITS.architectureLines}`);
for (const failure of failures) console.error('lint-docs: ' + failure);
console.log(`lint-docs: PLAN.md ${planBytes} bytes, ARCHITECTURE.md ${architectureLines} lines, ${failures.length} violation(s)`);
process.exit(failures.length === 0 ? 0 : 1);
