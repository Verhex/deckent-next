// Pure layout of the worker images (recipe schema 3, U6 §4): one shared local base (OS packages and the installer script), then each image
// FROM that base with one RUN layer per provider. Every install input is literal in its own RUN line (resolved npm version and registry,
// or the vendor installer's URL and sha256), so Docker's cache misses exactly that provider's layer when its input changes, and no build
// ARG is used anywhere: a version ARG would reach later RUN lines as an environment variable and miss their cache (Dockerfile reference,
// "Impact on build caching"). Labels and the revision come last, so a new revision never invalidates a layer. No Docker, no filesystem.
const INSTALLER = '/opt/deckent-worker/install.mjs';
const label = entries => 'LABEL ' + Object.entries(entries).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(' ');

/** Canonical rN base and rN-provider tags; dated versions remain receipt/history identities. */
export const imageTag = (repository, imageVersion, providers = []) => `${repository}:${[/^r[1-9][0-9]*/.exec(imageVersion)[0], ...providers].join('-')}`;

/** What one provider's RUN line installs: exactly the plan's resolved input, nothing taken from the network at build time unplanned. */
export function installDescriptor(recipe, plan, id) {
  const provider = recipe.providers.find(entry => entry.id === id), resolved = plan.providers[id];
  return resolved.kind === 'npm' ? { id, kind: 'npm', package: resolved.package, version: resolved.version, registry: plan.npmRegistry }
    : { id, kind: 'vendor-script', url: resolved.url, sha256: resolved.sha256, home: provider.installer.home, bin: provider.installer.bin, command: provider.command, refreshKey: plan.refreshKey };
}

/** The shared base. Its labels carry no revision, so an unchanged base keeps its image id across revisions and every provider layer stays cached. */
export function baseDockerfile(recipe, plan) {
  return [`FROM ${plan.base.image}`,
    `RUN ${JSON.stringify(['/bin/sh', '-c', `test -n ${JSON.stringify(plan.refreshKey)} && apt-get update && apt-get install -y --no-install-recommends ${recipe.base.apt.join(' ')} && rm -rf /var/lib/apt/lists/*`])}`,
    'COPY install.mjs /opt/deckent-worker/install.mjs',
    'ENV HOME=/tmp/deckent-home DISABLE_AUTOUPDATER=1',
    'WORKDIR /workspace',
    label({ 'org.opencontainers.image.title': recipe.baseRepository, 'org.opencontainers.image.base.name': plan.base.image }), ''].join('\n');
}

/** One image of the plan (its ordered providers), FROM this revision's base tag. `recipeSha256` is the shipped recipe's digest (the lineage key). */
export function imageDockerfile(recipe, plan, providers, meta) {
  return [`FROM ${imageTag(recipe.baseRepository, plan.imageVersion)}`,
    ...providers.map(id => `RUN ${meta.secret && plan.providers[id].kind === 'npm' ? '--mount=type=secret,id=worker-npmrc,required=true ' : ''}${JSON.stringify(['node', INSTALLER, JSON.stringify(installDescriptor(recipe, plan, id))])}`),
    label({ 'org.opencontainers.image.title': recipe.repository, 'org.opencontainers.image.version': plan.imageVersion,
      'org.opencontainers.image.revision': meta.sourceRevision, 'org.opencontainers.image.base.name': plan.base.image,
      'dev.deckent.worker.recipe.sha256': meta.recipeSha256, 'dev.deckent.worker.provider': providers.join(',') }),
    'USER node', ''].join('\n');
}
