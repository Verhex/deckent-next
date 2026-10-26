// Pure validation of the worker image recipe (schema 3), the build plan, the version history and the daemon's tag counter. No Docker, no
// filesystem: the builder runs these on its private build context before any Docker call, and the product's tests run them directly.
const VERSION = /^r[1-9][0-9]*-\d{8}$/;
/** Legacy dated tags remain readable; new tags are rN for the base and rN-provider for each provider image. */
const LEGACY_TAG = /^(r[1-9][0-9]*-\d{8})(?:-[a-z0-9]{1,32})*$/;
const TAG = /^(r[1-9][0-9]*)(?:-[a-z][a-z0-9]*(?:-[a-z0-9]+)*)?$/;
const LINE = /^# version (\S+) \| (\d{4}-\d{2}-\d{2}) \| base (\S+) \| supersedes (\S+) \| (.+)$/;
const ID = /^[a-z0-9]{1,32}$/;
const REPOSITORY = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;
const IMAGE = /^[a-z0-9][\w./:@-]{0,254}$/;
const NPM_PACKAGE = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/;
const NPM_VERSION = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;
const fail = code => { throw new Error(code); };
const counter = id => Number(/^r([1-9][0-9]*)(?:-|$)/.exec(id)[1]);
const strings = (value, pattern) => Array.isArray(value) && value.every(item => typeof item === 'string' && pattern.test(item));

/** A source URL the build may contact: https only (an http registry/installer, or a downgrade, is refused) and never with credentials,
 * which would land in the generated Dockerfile, `docker history` and the receipt. `proxy` also allows http (a proxy hop, not the source). */
export function assertSourceUrl(value, { proxy = false } = {}) {
  let url;
  try { url = new URL(value); } catch { fail('WORKER_IMAGE_SOURCE_INSECURE'); }
  if (url.username || url.password || url.search || url.hash) fail('WORKER_IMAGE_SOURCE_CREDENTIALS_REFUSED');
  if (url.protocol !== 'https:' && !(proxy && url.protocol === 'http:')) fail('WORKER_IMAGE_SOURCE_INSECURE');
  return value;
}

export function validateRecipe(recipe) {
  if (!recipe || recipe.schemaVersion !== 3) fail('WORKER_RECIPE_INVALID');
  if (![recipe.repository, recipe.baseRepository].every(name => typeof name === 'string' && REPOSITORY.test(name)) || recipe.repository === recipe.baseRepository) fail('WORKER_RECIPE_REPOSITORY');
  if (!recipe.base || typeof recipe.base.image !== 'string' || !IMAGE.test(recipe.base.image) || !strings(recipe.base.apt, /^[a-z0-9][a-z0-9+.-]*$/)) fail('WORKER_RECIPE_INVALID');
  if (!Array.isArray(recipe.providers) || !recipe.providers.length) fail('WORKER_RECIPE_INVALID');
  const ids = new Set();
  for (const provider of recipe.providers) {
    if (!ID.test(provider?.id ?? '') || ids.has(provider.id) || !/^[a-z0-9][\w.-]{0,63}$/.test(provider.command ?? '')
      || !strings(provider.helpArgs, /^[\w-]{1,64}$/) || !strings(provider.requiredFlags, /^--[\w-]{1,64}$/)) fail('WORKER_RECIPE_INVALID');
    ids.add(provider.id);
    const installer = provider.installer ?? {};
    if (installer.kind === 'npm') { if (!NPM_PACKAGE.test(installer.package ?? '')) fail('WORKER_RECIPE_INVALID'); continue; }
    if (installer.kind !== 'vendor-script' || !/^\/opt\/[a-z0-9][\w.-]{0,63}$/.test(installer.home ?? '') || !strings(installer.bin, /^[a-z0-9][\w.-]{0,63}$/) || !installer.bin.length) fail('WORKER_RECIPE_INVALID');
    assertSourceUrl(installer.url);
  }
  return recipe;
}

/**
 * The build plan the product wrote next to the shipped recipe (`plan.json`, never copied into an image): the version, the images (each an
 * ordered provider list), and every provider's concrete install input resolved at plan time (an npm version, or a vendor installer's
 * sha256). A provider without a concrete input is refused: no image is ever built from a moving `latest`.
 */
export function validatePlan(plan, recipe) {
  if (!plan || plan.schemaVersion !== 1 || !VERSION.test(plan.imageVersion ?? '')) fail('WORKER_PLAN_INVALID');
  if (plan.previousVersion !== null && (!VERSION.test(plan.previousVersion ?? '') || counter(plan.previousVersion) >= counter(plan.imageVersion))) fail('WORKER_PLAN_INVALID');
  if (!plan.base || typeof plan.base.image !== 'string' || !IMAGE.test(plan.base.image) || typeof plan.base.pull !== 'boolean') fail('WORKER_PLAN_INVALID');
  if (!Number.isSafeInteger(plan.buildTimeoutMs) || plan.buildTimeoutMs <= 0) fail('WORKER_PLAN_INVALID');
  if (!/^[0-9]{1,16}$/.test(plan.refreshKey ?? '')) fail('WORKER_PLAN_INVALID');
  const used = (Array.isArray(plan.images) ? plan.images : []).flat();
  if (!plan.images?.length || !plan.images.every(image => Array.isArray(image) && image.length === 1) || new Set(used).size !== used.length) fail('WORKER_PLAN_INVALID');
  for (const id of used) {
    const provider = recipe.providers.find(entry => entry.id === id), resolved = plan.providers?.[id];
    if (!provider) fail('WORKER_PLAN_INVALID');
    if (!resolved || resolved.kind !== provider.installer.kind) fail('WORKER_IMAGE_VERSIONS_UNRESOLVABLE');
    if (resolved.kind === 'npm' && (resolved.package !== provider.installer.package || !NPM_VERSION.test(resolved.version ?? ''))) fail('WORKER_IMAGE_VERSIONS_UNRESOLVABLE');
    if (resolved.kind === 'vendor-script') { if (!/^[a-f0-9]{64}$/.test(resolved.sha256 ?? '')) fail('WORKER_IMAGE_VERSIONS_UNRESOLVABLE'); assertSourceUrl(resolved.url); }
  }
  if (used.some(id => plan.providers[id].kind === 'npm')) assertSourceUrl(plan.npmRegistry);
  if (plan.proxy !== null) assertSourceUrl(plan.proxy, { proxy: true });
  return plan;
}

/** Parses newest-first "# version" lines and checks they agree with the plan: the newest line is this build. */
export function parseVersionHistory(text, plan) {
  const entries = text.split('\n').filter(line => line.startsWith('# version ') && !line.startsWith('# version <'))
    .map(line => { const m = LINE.exec(line); if (!m) fail('WORKER_HISTORY_LINE'); return { id: m[1], date: m[2], base: m[3], supersedes: m[4], reason: m[5].trim() }; });
  if (!entries.length) fail('WORKER_HISTORY_EMPTY');
  const ids = entries.map(e => e.id);
  if (new Set(ids).size !== ids.length || !ids.every(id => VERSION.test(id))) fail('WORKER_HISTORY_IDS');
  entries.forEach((entry, i) => {
    if (entry.supersedes === 'none') { if (i !== entries.length - 1) fail('WORKER_HISTORY_ORDER'); return; }
    if (ids.indexOf(entry.supersedes) <= i) fail('WORKER_HISTORY_ORDER');
  });
  // One revision counter names exactly one image set: counters strictly decrease newest-first, so rN never repeats with another date.
  if (entries.some((entry, i) => i > 0 && counter(entry.id) >= counter(entries[i - 1].id))) fail('WORKER_HISTORY_COUNTER');
  const newest = entries[0];
  if (newest.id !== plan.imageVersion || newest.base !== (plan.base?.image ?? plan.baseImage)) fail('WORKER_HISTORY_MISMATCH');
  if ((plan.previousVersion ?? 'none') !== newest.supersedes) fail('WORKER_HISTORY_MISMATCH');
  return entries;
}

/** Highest counter over canonical base/provider and legacy dated tags. Canonical tags carry the zero-date sentinel, or
 * null. Installations sharing one daemon share this one counter, so the planner floors its next counter on it (ISCI-IMAJ-SAYAC, U6 §12). */
export function heldVersion(existingTags) {
  return existingTags.flatMap(tag => LEGACY_TAG.exec(tag)?.[1] ?? (TAG.exec(tag)?.[1] ? `${TAG.exec(tag)[1]}-00000000` : [])).sort((a, b) => counter(b) - counter(a))[0] ?? null;
}

/** A label match is adoption evidence, never proof that this daemon image was built from these sources. */
export function adoptionProvenance(labels, lineage, providerIds) {
  const named = (labels['dev.deckent.worker.provider'] ?? '').split(',').filter(Boolean);
  const matched = named.length > 0 && new Set(named).size === named.length && named.every(id => providerIds.includes(id))
    && Array.isArray(lineage?.recipes) && lineage.recipes.some(entry => entry?.sha256 === labels['dev.deckent.worker.recipe.sha256']
      && entry.version === labels['org.opencontainers.image.version'] && named.every(id => entry.providers?.includes(id)));
  return matched ? 'adopted-label-matched' : 'adopted-lineage-unknown';
}

/** A new build must advance past every revision the daemon already holds in either repository; this refuses a second rN (an image tagged
 * by another installation between the planner's read and this build). A higher held counter is never adopted, only advanced past. */
export function assertVersionAdvances(imageVersion, existingTags) {
  if (!VERSION.test(imageVersion)) fail('WORKER_RECIPE_VERSION');
  const held = heldVersion(existingTags);
  if (held && counter(held) >= counter(imageVersion)) {
    throw new Error(`WORKER_VERSION_COUNTER_TAKEN: ${imageVersion} does not advance past ${held} already held by the daemon. Plan a counter past it; the automatic toolchain update does so on its next check.`);
  }
}
