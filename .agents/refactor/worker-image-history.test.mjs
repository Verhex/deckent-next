import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateRecipe, parseVersionHistory, assertVersionAdvances } from '../../assets/worker-image/history.mjs';

const recipe = () => ({ schemaVersion: 2, repository: 'deckent/worker', imageVersion: 'r2-20260922', previousVersion: 'r1-20260921', baseImage: 'node:24-trixie-slim' });
const lines = (...extra) => ['# version <id> | <date> | base <image> | supersedes <id|none> | <reason>', ...extra,
  '# version r2-20260922 | 2026-09-22 | base node:24-trixie-slim | supersedes r1-20260921 | second',
  '# version r1-20260921 | 2026-09-21 | base node:24-trixie-slim | supersedes none | first', 'FROM x'].join('\n');

const shipped = async () => JSON.parse(await readFile(new URL('../../assets/worker-image/recipe.json', import.meta.url), 'utf8'));
// Recipe schema 3 (alpha.56 U6-S1): the history lives in history.log (no Dockerfile is shipped) and the base image under base.image.
test('the shipped version history agrees with the shipped recipe identity', async () => {
  const r = validateRecipe(await shipped());
  const history = parseVersionHistory(await readFile(new URL('../../assets/worker-image/history.log', import.meta.url), 'utf8'), r);
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

test('recipe identity mismatches are refused before any Docker call', async () => {
  assert.throws(() => parseVersionHistory(lines(), { ...recipe(), imageVersion: 'r3-20260923' }), /WORKER_HISTORY_MISMATCH/);
  assert.throws(() => parseVersionHistory(lines(), { ...recipe(), previousVersion: null }), /WORKER_HISTORY_MISMATCH/);
  assert.throws(() => parseVersionHistory(lines(), { ...recipe(), baseImage: 'node:24-slim' }), /WORKER_HISTORY_MISMATCH/);
  const good = await shipped();
  assert.throws(() => validateRecipe({ ...good, schemaVersion: 2 }), /WORKER_RECIPE_INVALID/);
  assert.throws(() => validateRecipe({ ...good, repository: 'Deckent/Worker' }), /WORKER_RECIPE_REPOSITORY/);
  assert.throws(() => validateRecipe({ ...good, baseRepository: good.repository }), /WORKER_RECIPE_REPOSITORY/);
  assert.throws(() => validateRecipe({ ...good, base: { ...good.base, image: '--evil' } }), /WORKER_RECIPE_INVALID/);
  assert.throws(() => validateRecipe({ ...good, providers: [...good.providers, good.providers[0]] }), /WORKER_RECIPE_INVALID/); // a duplicate provider id
  const cursor = good.providers.find(provider => provider.installer.kind === 'vendor-script');
  assert.throws(() => validateRecipe({ ...good, providers: [{ ...cursor, installer: { ...cursor.installer, url: 'http://cursor.com/install' } }] }), /WORKER_IMAGE_SOURCE_INSECURE/);
  assert.equal(validateRecipe(good), good);
});

test('lineage: revision counters strictly decrease newest-first, so a second rN can never enter the history', () => {
  const second = { ...recipe(), imageVersion: 'r2-20260930', previousVersion: 'r2-20260922' };
  assert.throws(() => parseVersionHistory(lines('# version r2-20260930 | 2026-09-30 | base node:24-trixie-slim | supersedes r2-20260922 | second r2'), second), /WORKER_HISTORY_COUNTER/);
  const skipBack = { ...recipe(), imageVersion: 'r1-20260930', previousVersion: 'r2-20260922' };
  assert.throws(() => parseVersionHistory(lines('# version r1-20260930 | 2026-09-30 | base node:24-trixie-slim | supersedes r2-20260922 | backwards'), skipBack), /WORKER_HISTORY_COUNTER/);
  const next = { ...recipe(), imageVersion: 'r3-20260930', previousVersion: 'r2-20260922' };
  assert.equal(parseVersionHistory(lines('# version r3-20260930 | 2026-09-30 | base node:24-trixie-slim | supersedes r2-20260922 | next'), next)[0].id, 'r3-20260930');
});

test('lineage: a new build counter must exceed every counter the daemon already holds for the repository', () => {
  // The observed hazard: package recipe still at r2 while the daemon already holds r3-20260922 from a product-path build.
  assert.throws(() => assertVersionAdvances('r3-20260930', ['r1-20260921', 'r2-20260922', 'r3-20260922']), /WORKER_VERSION_COUNTER_TAKEN: r3-20260930 .* r3-20260922/);
  assert.throws(() => assertVersionAdvances('r3-20260930', ['r5-20260101']), /WORKER_VERSION_COUNTER_TAKEN/);
  assert.throws(() => assertVersionAdvances('r3-20260922', ['r3-20260922']), /WORKER_VERSION_COUNTER_TAKEN/);
  // After r3 exists the next revision is r4; unrelated tags (latest, <none>, other schemes) are ignored.
  assert.doesNotThrow(() => assertVersionAdvances('r4-20260930', ['r1-20260921', 'r2-20260922', 'r3-20260922', 'latest', '<none>', 'r3-20260922-local', '']));
  assert.doesNotThrow(() => assertVersionAdvances('r1-20260921', []));
  assert.throws(() => assertVersionAdvances('v4', []), /WORKER_RECIPE_VERSION/);
});
