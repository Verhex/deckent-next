#!/usr/bin/env node
// Documentation-preservation check: every non-empty line removed from the given documents (vs a git ref)
// must still appear verbatim in the current document set (PLAN, ARCHITECTURE, COMPLETED-PLAN, .deckent/docs/**/*.md).
// Normalisation: trailing/leading whitespace trimmed, leading markdown heading marks ignored (heading demotion when a
// section moves). Table separator rows and horizontal rules carry no content and are counted separately.
// Usage: node scripts/check-doc-preservation.mjs [--ref HEAD] [--verbose] [PLAN.md ARCHITECTURE.md]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const args = process.argv.slice(2);
let ref = 'HEAD'; let verbose = false; const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--ref') ref = args[++i]; else if (args[i] === '--verbose') verbose = true; else files.push(args[i]);
}
if (files.length === 0) files.push('PLAN.md', 'ARCHITECTURE.md');
const norm = (line) => line.trim().replace(/^#+\s+/, '');
const separator = (line) => /^\|?[\s:|-]*-[\s:|-]*\|?$/.test(line.trim()) || /^[-*_]{3,}$/.test(line.trim());
const walk = (dir) => readdirSync(dir).flatMap(name => { const p = join(dir, name); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.md') ? [p] : []; });
const corpusFiles = ['PLAN.md', 'ARCHITECTURE.md', 'COMPLETED-PLAN.md', ...(existsSync(join(ROOT, '.deckent/docs')) ? walk(join(ROOT, '.deckent/docs')).map(p => p.slice(ROOT.length)) : [])];
const corpus = new Set();
for (const file of corpusFiles) if (existsSync(join(ROOT, file))) for (const line of readFileSync(join(ROOT, file), 'utf8').split('\n')) corpus.add(norm(line));
let removed = 0; let found = 0; let skipped = 0; const missing = [];
for (const file of files) {
  const old = execFileSync('git', ['show', `${ref}:${file}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n');
  const current = new Set(readFileSync(join(ROOT, file), 'utf8').split('\n').map(norm));
  for (const [index, line] of old.entries()) {
    if (norm(line) === '') continue;
    if (current.has(norm(line))) continue; // still present in the same file
    removed++;
    if (separator(line)) { skipped++; continue; }
    if (corpus.has(norm(line))) found++; else missing.push(`${file}:${index + 1}: ${line.slice(0, 160)}`);
  }
}
console.log(`removed non-empty lines: ${removed}; found elsewhere: ${found}; separators/rules (no content): ${skipped}; not found: ${missing.length}`);
if (verbose || missing.length) for (const m of missing.slice(0, 200)) console.log('  MISSING ' + m);
process.exit(missing.length === 0 ? 0 : 1);
