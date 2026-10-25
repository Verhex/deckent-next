import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const path = 'assets/worker-image/lineage.json';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
/** Release tooling is the sole producer. Builds/checks only verify; a recipe edit without an appended entry fails packaging. */
export function workerLineage(root, write = false) {
  const recipeBytes = readFileSync(join(root, 'assets/worker-image/recipe.json'));
  const recipe = JSON.parse(recipeBytes), digest = sha(recipeBytes);
  let prior = [];
  try { prior = JSON.parse(execFileSync('git', ['-C', root, 'show', `HEAD:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).recipes; }
  catch { /* First release with lineage has no prior file; legacy image provenance stays unknown. */ }
  const file = join(root, path), lock = join(root, 'assets/worker-image/lineage.lock.json');
  const data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { schemaVersion: 1, recipes: [] };
  if (data.schemaVersion !== 1 || !Array.isArray(data.recipes) || new Set(data.recipes.map(entry => entry.sha256)).size !== data.recipes.length
    || prior.some((entry, index) => JSON.stringify(data.recipes[index]) !== JSON.stringify(entry))) throw new Error('WORKER_LINEAGE_INVALID');
  if (write && !data.recipes.some(entry => entry.sha256 === digest)) data.recipes.push({ sha256: digest, version: recipe.imageVersion, providers: recipe.providers.map(provider => provider.id) });
  if (!data.recipes.some(entry => entry.sha256 === digest && entry.version === recipe.imageVersion
    && JSON.stringify(entry.providers) === JSON.stringify(recipe.providers.map(provider => provider.id)))) throw new Error('WORKER_LINEAGE_INVALID');
  if (write) {
    writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
    writeFileSync(lock, JSON.stringify({ schemaVersion: 1, sha256: sha(readFileSync(file)) }, null, 2) + '\n');
  }
  if (JSON.parse(readFileSync(lock, 'utf8')).sha256 !== sha(readFileSync(file))) throw new Error('WORKER_LINEAGE_INVALID');
  return data;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.length && args[0] !== '--write') throw new Error('WORKER_LINEAGE_ARGUMENTS');
  workerLineage(dirname(dirname(fileURLToPath(import.meta.url))), args[0] === '--write');
}
