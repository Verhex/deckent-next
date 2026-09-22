import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateRecipe, parseVersionHistory } from '../../assets/worker-image/history.mjs';

const recipe = () => ({ schemaVersion: 2, repository: 'deckent/worker', imageVersion: 'r2-20260922', previousVersion: 'r1-20260921', baseImage: 'node:24-trixie-slim' });
const lines = (...extra) => ['# version <id> | <date> | base <image> | supersedes <id|none> | <reason>', ...extra,
  '# version r2-20260922 | 2026-09-22 | base node:24-trixie-slim | supersedes r1-20260921 | second',
  '# version r1-20260921 | 2026-09-21 | base node:24-trixie-slim | supersedes none | first', 'FROM x'].join('\n');

test('the shipped Dockerfile history agrees with the shipped recipe identity', async () => {
  const r = validateRecipe(JSON.parse(await readFile(new URL('../../assets/worker-image/recipe.json', import.meta.url), 'utf8')));
  const history = parseVersionHistory(await readFile(new URL('../../assets/worker-image/Dockerfile', import.meta.url), 'utf8'), r);
  assert.equal(history[0].id, r.imageVersion); assert.equal(history[0].supersedes, r.previousVersion ?? 'none');
  assert.equal(history.at(-1).supersedes, 'none');
});

test('history parsing: template line ignored, newest first, chain must resolve to an older entry, ends with none', () => {
  const history = parseVersionHistory(lines(), recipe());
  assert.deepEqual(history.map(h => [h.id, h.supersedes, h.reason]), [['r2-20260922', 'r1-20260921', 'second'], ['r1-20260921', 'none', 'first']]);
  assert.throws(() => parseVersionHistory('FROM x', recipe()), /WORKER_HISTORY_EMPTY/);
  assert.throws(() => parseVersionHistory(lines('# version r3-20260923 | 2026-09-23 | base node:24-trixie-slim | supersedes r9-20260101 | dangling'), { ...recipe(), imageVersion: 'r3-20260923', previousVersion: 'r9-20260101' }), /WORKER_HISTORY_ORDER/);
  assert.throws(() => parseVersionHistory(lines('# version r0-20260923 | 2026-09-23 | base b | supersedes none | early none'), recipe()), /WORKER_HISTORY_IDS|WORKER_HISTORY_ORDER/);
  assert.throws(() => parseVersionHistory(lines('# version r2-20260922 | 2026-09-22 | base b | supersedes r1-20260921 | duplicate'), recipe()), /WORKER_HISTORY_IDS/);
  assert.throws(() => parseVersionHistory('# version broken line\nFROM x', recipe()), /WORKER_HISTORY_LINE/);
});

test('recipe identity mismatches are refused before any Docker call', () => {
  assert.throws(() => parseVersionHistory(lines(), { ...recipe(), imageVersion: 'r3-20260923' }), /WORKER_HISTORY_MISMATCH/);
  assert.throws(() => parseVersionHistory(lines(), { ...recipe(), previousVersion: null }), /WORKER_HISTORY_MISMATCH/);
  assert.throws(() => parseVersionHistory(lines(), { ...recipe(), baseImage: 'node:24-slim' }), /WORKER_HISTORY_MISMATCH/);
  assert.throws(() => validateRecipe({ ...recipe(), schemaVersion: 1 }), /WORKER_RECIPE_INVALID/);
  assert.throws(() => validateRecipe({ ...recipe(), imageVersion: 'v2' }), /WORKER_RECIPE_VERSION/);
  assert.throws(() => validateRecipe({ ...recipe(), previousVersion: 'r2-20260922' }), /WORKER_RECIPE_PREVIOUS/);
  assert.throws(() => validateRecipe({ ...recipe(), repository: 'Deckent/Worker' }), /WORKER_RECIPE_REPOSITORY/);
  assert.throws(() => validateRecipe({ ...recipe(), baseImage: '--evil' }), /WORKER_RECIPE_INVALID/);
  assert.equal(validateRecipe({ ...recipe(), previousVersion: null }).previousVersion, null);
});
