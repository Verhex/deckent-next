import { HUB_LIMITS, HubError, canonicalHubJson, isAiPrincipal, type HubRevocationFeed, type VerifiedPrincipal } from '#domain/index.js';
import { sha256 } from '#platform/index.js';
import { AgentCatalogApplication, AgentStandingApplication, personaDigest, skillSetDigest } from '#engine/core/agent-catalog/index.js';
import { hubSkillDocumentBody, skillContentV2Digest } from '#engine/core/hub/index.js';
import { HubClientError, type HubBundle, type HubClientDependencies, type HubClientStore, type HubInstall, type HubSource } from './contract.js';
import { decodeHubBundle, encodeHubBundle } from './bundle.js';
import { acceptClientFeed, higherHubVersion, requirePackageNotRevoked, verifyClientBundle } from './verification.js';
type Command = { scopeId: string; commandId: string; hubId: string; workClassMapping: Readonly<Record<string, string>>; feeds: Readonly<Record<string, HubRevocationFeed>> };
export const hubItemCommandId = (commandId: string, kind: string, id: string) => sha256(canonicalHubJson({ commandId, kind, id }));
/** Exact dependency closure, children first. Cached dependencies are verified identically; no fetch port exists. */
export async function installClientBundles(deps: HubClientDependencies, store: HubClientStore, source: HubSource, bundles: readonly HubBundle[], feed: HubRevocationFeed,
  command: Command, principal: VerifiedPrincipal, update: boolean): Promise<readonly HubInstall[]> {
  const bundleId = (bundle: HubBundle) => `${bundle.envelope.signatures.find(s => s.role === 'hub')?.keyId}/${bundle.manifest.packageId}@${bundle.manifest.version}`;
  const byId = new Map(bundles.map(bundle => [bundleId(bundle), bundle])), visiting = new Set<string>(), visited = new Set<string>();
  const ordered: { bundle: HubBundle; source: HubSource; feed: HubRevocationFeed; keys: Awaited<ReturnType<typeof verifyClientBundle>> }[] = [];
  if (byId.size !== bundles.length) throw new HubClientError('HUB_DEPENDENCY_REFUSED');
  async function visit(bundle: HubBundle, nodeSource: HubSource, nodeFeed: HubRevocationFeed, depth: number): Promise<void> {
    const id = bundleId(bundle);
    if (depth > HUB_LIMITS.dependencyDepthMax || visiting.has(id)) throw new HubClientError('HUB_DEPENDENCY_REFUSED');
    if (visited.has(id)) return;
    if (visited.size + visiting.size >= HUB_LIMITS.dependenciesMax + 1) throw new HubError('HUB_LIMIT_EXCEEDED');
    visiting.add(id);
    const keys = await verifyClientBundle(deps, store, nodeSource, bundle, principal); await requirePackageNotRevoked(store, nodeSource, bundle, nodeFeed);
    for (const dependency of bundle.manifest.dependencies) {
      const hubId = dependency.hubId ?? nodeSource.hubId;
      const depSource = hubId === nodeSource.hubId ? nodeSource : await store.source(command.scopeId, hubId);
      if (!depSource || depSource.state !== 'active') throw new HubClientError('HUB_DEPENDENCY_REFUSED');
      const rawFeed = hubId === nodeSource.hubId ? nodeFeed : command.feeds[hubId] ?? await store.feed(command.scopeId, hubId);
      if (!rawFeed) throw new HubError('HUB_FEED_STALE');
      const depFeed = await acceptClientFeed(deps, store, depSource, rawFeed, true);
      let child = byId.get(`${hubId}/${dependency.packageId}@${dependency.version}`);
      if (!child) {
        const installed = await store.install(command.scopeId, hubId, dependency.packageId, dependency.version);
        if (!installed || installed.state !== 'installed') throw new HubClientError('HUB_DEPENDENCY_REFUSED');
        child = decodeHubBundle(await deps.artifacts.read(command.scopeId, installed.bundle));
      }
      if (child.envelope.payloadDigest !== dependency.manifestDigest) throw new HubClientError('HUB_DEPENDENCY_REFUSED');
      await visit(child, depSource, depFeed, depth + 1);
    }
    visiting.delete(id); visited.add(id); ordered.push({ bundle, source: nodeSource, feed: nodeFeed, keys });
  }
  await visit(bundles[0]!, source, feed, 0);
  if (bundles.some(bundle => !visited.has(bundleId(bundle)))) throw new HubClientError('HUB_DEPENDENCY_REFUSED');
  const versions = new Set<string>();
  for (const node of ordered) { const id = `${node.source.hubId}/${node.bundle.manifest.packageId}`;
    if (versions.has(id)) throw new HubClientError('HUB_DEPENDENCY_REFUSED'); versions.add(id); }
  // Every node is verified under its own source and signed feed before the first catalog mutation.
  const results: HubInstall[] = [], catalogDeps = { ...deps.catalog, verifier: { verify: async () => principal }, openStore: async () => store.borrowCatalog() };
  for (const { bundle, source: nodeSource, keys: trust } of ordered) {
    const source = nodeSource;
    const manifest = bundle.manifest, prior = await store.install(command.scopeId, source.hubId, manifest.packageId), root = bundle === bundles[0];
    if (prior && (prior.version !== manifest.version || root && update) && !higherHubVersion(manifest.version, prior.version)) throw new HubClientError('HUB_DOWNGRADE_REFUSED');
    if (root && !update && prior && prior.version !== manifest.version) throw new HubClientError('HUB_INSTALL_CONFLICT');
    await deps.authorize(prior && prior.version !== manifest.version ? 'update' : 'install', command.scopeId, principal);
    if (root && update && !prior) throw new HubClientError('HUB_INSTALL_CONFLICT');
    if (prior?.version === manifest.version) {
      if (prior.manifestDigest !== bundle.envelope.payloadDigest || prior.state !== 'installed') throw new HubClientError('HUB_INSTALL_CONFLICT');
      results.push(prior); continue;
    }
    const ownItems = new Map(prior?.items.map(row => [`${row.kind}/${row.id}`, row]) ?? []), installedItems: HubInstall['items'][number][] = [];
    const publisherKind = trust.publisherKind ?? 'unknown';
    const catalog = new AgentCatalogApplication({ ...catalogDeps, openStore: async () => store.borrowCatalog({ scopeId: command.scopeId, key: trust.publisher }) });
    for (const item of manifest.items.filter(item => item.kind === 'skill')) {
      const previous = await store.loadSkill(command.scopeId, item.skillId), own = ownItems.get(`skill/${item.skillId}`);
      if (previous && (!own || previous.revision !== own.revision || previous.contentDigest !== own.digest)) throw new HubClientError('HUB_INSTALL_CONFLICT');
      const document = bundle.files.find(file => file.path === `skills/${item.name}/SKILL.md`)!.bytes;
      const content = { name: item.name, description: item.description, text: hubSkillDocumentBody(new TextDecoder('utf-8', { fatal: true }).decode(document), item.name, item.description), files: item.files };
      const result = await catalog.importHubSkill({ schemaVersion: 1, scopeId: command.scopeId, commandId: hubItemCommandId(command.commandId, 'skill', `${manifest.packageId}/${item.skillId}`),
        skillId: item.skillId, expectedRevision: previous?.revision ?? null, content, source: { ref: `hub:${source.hubId}/${manifest.packageId}@${manifest.version}` },
        pin: skillContentV2Digest(content), signature: item.signature });
      installedItems.push({ kind: 'skill', id: item.skillId, revision: result.item.revision, digest: result.item.contentDigest });
    }
    // Parents must be in this package. Topological order avoids a transient missing parent without weakening catalog tree validation.
    const remaining = new Map(manifest.items.filter(item => item.kind === 'agent').map(item => [item.agentId, item]));
    while (remaining.size) {
      const ready = [...remaining.values()].find(item => !item.parentHint || !remaining.has(item.parentHint));
      if (!ready) throw new HubClientError('HUB_DEPENDENCY_REFUSED');
      const item = ready, previous = await store.loadAgent(command.scopeId, item.agentId), own = ownItems.get(`agent/${item.agentId}`);
      if (previous && (!own || previous.revision !== own.revision || previous.personaDigest !== own.digest)) throw new HubClientError('HUB_INSTALL_CONFLICT');
      if (item.parentHint && !manifest.items.some(row => row.kind === 'agent' && row.agentId === item.parentHint)) throw new HubClientError('HUB_DEPENDENCY_REFUSED');
      const knownClasses = deps.catalog.workClassIds ? await deps.catalog.workClassIds(command.scopeId) : [];
      const workClasses = item.workClassHints.map(hint => {
        const mapped = command.workClassMapping[hint] ?? hint;
        if (!knownClasses.includes(mapped) || isAiPrincipal(principal) && mapped !== hint) throw new HubClientError('HUB_DEPENDENCY_REFUSED');
        return mapped;
      });
      const skills = [];
      for (const ref of item.skills) {
        const self = ref.packageId === manifest.packageId && ref.version === manifest.version;
        if (!self && !manifest.dependencies.some(dep => dep.packageId === ref.packageId && dep.version === ref.version)) throw new HubClientError('HUB_DEPENDENCY_REFUSED');
        const match = self ? installedItems.find(row => row.kind === 'skill' && row.id === ref.skillId) : (await store.install(command.scopeId, manifest.dependencies.find(dep => dep.packageId === ref.packageId && dep.version === ref.version)?.hubId ?? source.hubId, ref.packageId, ref.version))?.items.find(row => row.kind === 'skill' && row.id === ref.skillId);
        if (!match || match.digest !== ref.digest) throw new HubClientError('HUB_DEPENDENCY_REFUSED');
        skills.push({ skillId: match.id, revision: match.revision, digest: match.digest });
      }
      const carryStanding = !!prior && prior.publisherKeyId === trust.publisher.keyId && prior.publisherKind === 'person' && publisherKind === 'person'
        && canonicalHubJson([...(previous?.content.workClasses ?? [])].sort()) === canonicalHubJson([...workClasses].sort());
      const result = await catalog.defineAgent({ schemaVersion: 1, scopeId: command.scopeId, commandId: hubItemCommandId(command.commandId, 'agent', `${manifest.packageId}/${item.agentId}`),
        agentId: item.agentId, expectedRevision: previous?.revision ?? null, content: { name: item.name, persona: item.persona, workClasses, skills, parentAgentId: item.parentHint } }, undefined, { carryStanding });
      installedItems.push({ kind: 'agent', id: item.agentId, revision: result.item.revision, digest: result.item.personaDigest }); remaining.delete(item.agentId);
    }
    if (prior) {
      await retireClientInstall(deps, store, prior, principal, command.commandId, new Set(installedItems.filter(row => row.kind === 'agent').map(row => row.id)));
      await store.saveInstall(prior, { ...prior, state: 'retired', revision: prior.revision + 1 });
    }
    const record: HubInstall = { schemaVersion: 1, scopeId: command.scopeId, hubId: source.hubId, packageId: manifest.packageId, version: manifest.version,
      manifestDigest: bundle.envelope.payloadDigest, publisherKeyId: trust.publisher.keyId, signerKeyIds: bundle.envelope.signatures.map(s => s.keyId), publisherKind, state: 'installed', revision: 1, items: installedItems,
      bundle: await deps.artifacts.put(command.scopeId, encodeHubBundle(bundle)), atMs: deps.catalog.now(), sourceRevision: source.revision };
    await store.saveInstall(null, record); results.push(record);
  }
  return results;
}
/** Retire current package-owned agents through the existing signed standing transition; retained revisions and frozen Run pins remain readable. */
export async function retireClientInstall(deps: HubClientDependencies, store: HubClientStore, installed: HubInstall, principal: VerifiedPrincipal, commandId: string, retained = new Set<string>()) {
  const standing = new AgentStandingApplication({ ...deps.catalog, verifier: { verify: async () => principal }, openStore: async () => store.borrowCatalog() });
  for (const item of installed.items.filter(row => row.kind === 'agent' && !retained.has(row.id))) {
    const current = await store.loadAgent(installed.scopeId, item.id);
    if (current?.revision !== item.revision) continue;
    for (const row of await store.standings(installed.scopeId, item.id, item.revision)) if (row.standing !== 'retired')
      await standing.change({ schemaVersion: 1, scopeId: installed.scopeId, commandId: hubItemCommandId(commandId, 'retire', `${installed.packageId}/${item.id}/${row.workClass}`),
        action: 'retire', agentId: item.id, revision: item.revision, workClass: row.workClass, expectedStandingRevision: row.standingRevision, suggestionId: null });
  }
}
export async function verifyInstalledClientBundle(deps: HubClientDependencies, store: HubClientStore, source: HubSource, installed: HubInstall, principal: VerifiedPrincipal, seen = new Set<string>(), depth = 0): Promise<HubBundle> {
  const bundle = decodeHubBundle(await deps.artifacts.read(installed.scopeId, installed.bundle));
  if (bundle.manifest.packageId !== installed.packageId || bundle.manifest.version !== installed.version || bundle.envelope.payloadDigest !== installed.manifestDigest) throw new HubClientError('HUB_STORE_CORRUPT');
  await verifyClientBundle(deps, store, source, bundle, principal, true);
  const identity = `${source.hubId}/${installed.packageId}@${installed.version}`;
  if (seen.has(identity) || depth > HUB_LIMITS.dependencyDepthMax || seen.size > HUB_LIMITS.dependenciesMax) throw new HubClientError('HUB_DEPENDENCY_REFUSED');
  seen.add(identity);
  if (installed.items.length !== bundle.manifest.items.length) throw new HubClientError('HUB_STORE_CORRUPT');
  for (const ref of installed.items) {
    const expected = bundle.manifest.items.find(item => item.kind === ref.kind && (item.kind === 'skill' ? item.skillId : item.agentId) === ref.id);
    if (!expected) throw new HubClientError('HUB_STORE_CORRUPT');
    if (expected.kind === 'skill') {
      const row = await store.loadSkill(installed.scopeId, ref.id, ref.revision);
      const bytes = bundle.files.find(file => file.path === `skills/${expected.name}/SKILL.md`)!.bytes;
      const text = hubSkillDocumentBody(new TextDecoder('utf-8', { fatal: true }).decode(bytes), expected.name, expected.description);
      const digest = skillContentV2Digest({ name: expected.name, description: expected.description, text, files: expected.files });
      if (!row || row.schemaVersion !== 2 || row.contentDigest !== ref.digest || row.contentDigest !== digest || skillContentV2Digest(row.content) !== digest
        || row.signature.status !== 'verified' || row.signature.keyId !== expected.signature.keyId || row.signature.value !== expected.signature.value) throw new HubClientError('HUB_STORE_CORRUPT');
    } else {
      const row = await store.loadAgent(installed.scopeId, ref.id, ref.revision);
      if (!row || row.content.name !== expected.name || row.content.persona !== expected.persona || row.personaDigest !== ref.digest
        || personaDigest(row.content.persona) !== row.personaDigest || skillSetDigest(row.content.skills) !== row.skillSetDigest) throw new HubClientError('HUB_STORE_CORRUPT');
    }
  }
  for (const dependency of bundle.manifest.dependencies) {
    const hubId = dependency.hubId ?? source.hubId, nextSource = await store.source(installed.scopeId, hubId);
    const next = await store.install(installed.scopeId, hubId, dependency.packageId, dependency.version);
    if (!nextSource || nextSource.state !== 'active' || !next || next.manifestDigest !== dependency.manifestDigest) throw new HubClientError('HUB_DEPENDENCY_REFUSED');
    // Shared DAG nodes have already been checked in this traversal; they are not a dependency cycle.
    if (!seen.has(`${hubId}/${next.packageId}@${next.version}`)) await verifyInstalledClientBundle(deps, store, nextSource, next, principal, seen, depth + 1);
  }

  const feed = await store.feed(installed.scopeId, source.hubId);
  if (!feed) throw new HubError('HUB_FEED_STALE');
  await acceptClientFeed(deps, store, source, feed, false);
  // Yanked packages remain verifiable/useable; only a revocation invalidates an installed package.
  await requirePackageNotRevoked(store, source, bundle, feed, true);
  return bundle;
}
