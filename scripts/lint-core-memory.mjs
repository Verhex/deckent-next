#!/usr/bin/env node
// Core-memory sync gate.
//
// Next owns the canonical in-repository core-memory set. Legacy is a frozen reference.
// The manifest always verifies local content and membership without an external dependency.
// DECKENT_CORE_MEMORY_CANONICAL optionally compares an explicitly selected reference copy;
// it is not a requirement to keep writing the pre-refactor repository.
//
// Refreshing the manifest after an authorized memory change: `node scripts/lint-core-memory.mjs --write`.
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, '.deckent/docs/core-memory');
const MANIFEST = join(ROOT, 'scripts/core-memory.sha256');
const digest = buffer => createHash('sha256').update(buffer).digest('hex');
const failures = [];
const fail = (scope, detail) => failures.push(`core-memory/${scope}: ${detail}`);

function read(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
  const entries = readdirSync(dir).filter(name => name.endsWith('.md')).sort();
  return new Map(entries.map(name => [name, digest(readFileSync(join(dir, name)))]));
}

const local = read(DIR);
if (local === null) { console.error(`core-memory: directory missing at ${DIR}`); process.exit(1); }
if (local.size === 0) { console.error('core-memory: no .md files found'); process.exit(1); }

if (process.argv.includes('--write')) {
  const body = [...local].map(([name, sha]) => `${sha}  ${name}`).join('\n');
  writeFileSync(MANIFEST, `${body}\n`);
  console.log(`core-memory: manifest written for ${local.size} file(s)`);
  process.exit(0);
}

// 1. Manifest
if (!existsSync(MANIFEST)) fail('manifest', `missing ${MANIFEST}; run: node scripts/lint-core-memory.mjs --write`);
else {
  const recorded = new Map(readFileSync(MANIFEST, 'utf8').split('\n').filter(Boolean)
    .map(line => { const [sha, name] = line.split(/\s+/); return [name, sha]; }));
  for (const [name, sha] of local) {
    if (!recorded.has(name)) fail('manifest', `untracked memory "${name}" — refresh the manifest if this change is authorized`);
    else if (recorded.get(name) !== sha) fail('manifest', `"${name}" changed since the manifest was written`);
  }
  for (const name of recorded.keys()) if (!local.has(name)) fail('manifest', `"${name}" recorded but missing from the copy`);
}

// 2. Canonical
const canonicalPath = process.env.DECKENT_CORE_MEMORY_CANONICAL;
if (!canonicalPath) console.log('core-memory: canonical comparison skipped (DECKENT_CORE_MEMORY_CANONICAL is not set)');
else {
  const canonical = read(resolve(canonicalPath));
  if (canonical === null) fail('canonical', `DECKENT_CORE_MEMORY_CANONICAL does not resolve to a directory: ${canonicalPath}`);
  else {
    for (const [name, sha] of canonical) {
      if (!local.has(name)) fail('canonical', `"${name}" exists in the canonical set but not here`);
      else if (local.get(name) !== sha) fail('canonical', `"${name}" differs from the canonical copy`);
    }
    for (const name of local.keys()) if (!canonical.has(name)) fail('canonical', `"${name}" exists here but not in the canonical set`);
    if (failures.length === 0) console.log(`core-memory: ${canonical.size} file(s) identical to the canonical set`);
  }
}

for (const line of failures) console.error(line);
console.log(`core-memory: ${local.size} file(s), ${failures.length} violation(s)`);
process.exit(failures.length === 0 ? 0 : 1);
