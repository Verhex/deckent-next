// Pure validation of the in-image version history and recipe identity. No Docker, no filesystem.
const VERSION = /^r[1-9][0-9]*-\d{8}$/;
const LINE = /^# version (\S+) \| (\d{4}-\d{2}-\d{2}) \| base (\S+) \| supersedes (\S+) \| (.+)$/;
const fail = code => { throw new Error(code); };
const counter = id => Number(/^r([1-9][0-9]*)-/.exec(id)[1]);

export function validateRecipe(recipe) {
  if (!recipe || recipe.schemaVersion !== 2) fail('WORKER_RECIPE_INVALID');
  if (typeof recipe.repository !== 'string' || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/.test(recipe.repository)) fail('WORKER_RECIPE_REPOSITORY');
  if (!VERSION.test(recipe.imageVersion)) fail('WORKER_RECIPE_VERSION');
  if (recipe.previousVersion !== null && !VERSION.test(recipe.previousVersion)) fail('WORKER_RECIPE_PREVIOUS');
  if (recipe.previousVersion === recipe.imageVersion) fail('WORKER_RECIPE_PREVIOUS');
  if (typeof recipe.baseImage !== 'string' || !recipe.baseImage || recipe.baseImage.startsWith('-')) fail('WORKER_RECIPE_INVALID');
  return recipe;
}

/** Parses newest-first "# version" lines and checks they agree with the recipe identity. */
export function parseVersionHistory(dockerfile, recipe) {
  const entries = dockerfile.split('\n').filter(line => line.startsWith('# version ') && !line.startsWith('# version <'))
    .map(line => { const m = LINE.exec(line); if (!m) fail('WORKER_HISTORY_LINE'); return { id: m[1], date: m[2], base: m[3], supersedes: m[4], reason: m[5].trim() }; });
  if (!entries.length) fail('WORKER_HISTORY_EMPTY');
  const ids = entries.map(e => e.id);
  if (new Set(ids).size !== ids.length || !ids.every(id => VERSION.test(id))) fail('WORKER_HISTORY_IDS');
  entries.forEach((entry, i) => {
    if (entry.supersedes === 'none') { if (i !== entries.length - 1) fail('WORKER_HISTORY_ORDER'); return; }
    if (ids.indexOf(entry.supersedes) <= i) fail('WORKER_HISTORY_ORDER');
  });
  // One revision counter names exactly one image: counters strictly decrease newest-first, so rN never repeats with another date.
  if (entries.some((entry, i) => i > 0 && counter(entry.id) >= counter(entries[i - 1].id))) fail('WORKER_HISTORY_COUNTER');
  const newest = entries[0];
  if (newest.id !== recipe.imageVersion || newest.base !== recipe.baseImage) fail('WORKER_HISTORY_MISMATCH');
  if ((recipe.previousVersion ?? 'none') !== newest.supersedes) fail('WORKER_HISTORY_MISMATCH');
  return entries;
}

/** The highest revision the daemon holds for the repository (tags in the r<N>-<date> scheme), or null. Other tags are ignored.
 * Installations sharing one daemon share this namespace, so the planner floors its next counter on it (ISCI-IMAJ-SAYAC). */
export function heldVersion(existingTags) {
  return existingTags.filter(tag => VERSION.test(tag)).sort((a, b) => counter(b) - counter(a))[0] ?? null;
}

/** A new build must advance past every revision the daemon already holds for the repository; this refuses a second rN (an image tagged
 * by another installation between the planner's read and this build). A higher held counter is never adopted, only advanced past. */
export function assertVersionAdvances(imageVersion, existingTags) {
  if (!VERSION.test(imageVersion)) fail('WORKER_RECIPE_VERSION');
  const held = heldVersion(existingTags);
  if (held && counter(held) >= counter(imageVersion)) {
    throw new Error(`WORKER_VERSION_COUNTER_TAKEN: ${imageVersion} does not advance past ${held} already held by the daemon. Plan a counter past it; the automatic toolchain update does so on its next check.`);
  }
}
