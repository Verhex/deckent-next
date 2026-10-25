import { isDeepStrictEqual } from 'node:util';
import { HUB_TRUST_POLICIES, HubError, type HubRevocationFeed, type VerifiedPrincipal } from '#domain/index.js';
import { ed25519KeyId } from '#platform/index.js';
import { verifyHubPackage, verifyHubRevocationFeed } from '#engine/core/hub/index.js';
import { HubClientError, type HubBundle, type HubClientDependencies, type HubClientStore, type HubSource, type HubClientTrust } from './contract.js';
/** Every trust resolver is a trusted composition port; publisher-pinned is resolved here from the current scope's signer rows. */
export async function verifyClientBundle(deps: HubClientDependencies, store: HubClientStore, source: HubSource, bundle: HubBundle, principal: VerifiedPrincipal): Promise<HubClientTrust> {
  const nowMs = deps.catalog.now(), publisherId = bundle.envelope.signatures.find(s => s.role === 'publisher')?.keyId;
  const policy = HUB_TRUST_POLICIES.policies.find(p => p.id === source.trustPolicy)!;
  let keys: HubClientTrust;
  if (policy.publisherPinned && policy.reviewers === 'none' && !policy.moderation) {
    const publisher = publisherId ? await store.signer(source.scopeId, publisherId) : null;
    if (!publisher || publisher.state !== 'active' || publisher.purpose !== 'import') throw new HubError('HUB_SIGNER_UNTRUSTED');
    const reviewers = [];
    for (const signature of bundle.envelope.signatures.filter(s => s.role === 'reviewer')) {
      const key = await store.signer(source.scopeId, signature.keyId);
      if (!key || key.state !== 'active' || key.purpose !== 'import') throw new HubError('HUB_SIGNER_UNTRUSTED');
      reviewers.push({ keyId: key.keyId, publicKey: key.publicKey, role: 'reviewer' as const, active: true });
    }
    keys = { publisher: { keyId: publisher.keyId, publicKey: publisher.publicKey, role: 'publisher', active: true },
      hub: { keyId: source.hubId, publicKey: source.publicKey, role: 'hub', active: true }, reviewers };
  } else {
    if (!deps.resolveTrust) throw new HubError('HUB_SIGNER_UNTRUSTED');
    keys = await deps.resolveTrust(source, bundle, principal, store, nowMs);
  }
  if (!keys.hub || keys.hub.publicKey !== source.publicKey || keys.hub.keyId !== source.hubId
    || ed25519KeyId(Buffer.from(keys.hub.publicKey, 'base64')) !== source.hubId) throw new HubError('HUB_IDENTITY_MISMATCH');
  if (deps.resolveTrust && policy.publisherPinned && policy.reviewers === 'none' && !policy.moderation) {
    const resolved = await deps.resolveTrust(source, bundle, principal, store, nowMs);
    if (resolved.publisher.keyId !== keys.publisher.keyId || resolved.publisher.publicKey !== keys.publisher.publicKey) throw new HubError('HUB_SIGNER_UNTRUSTED');
    keys = { ...keys, ...(resolved.publisherKind ? { publisherKind: resolved.publisherKind } : {}) };
  }
  const revoked = deps.catalog.revocations ? await deps.catalog.revocations.list() : [];
  if (revoked.some(row => row.scopeId === source.scopeId && [keys.publisher.keyId, keys.hub!.keyId, ...keys.reviewers.map(k => k.keyId)].includes(row.keyId))) throw new HubError('HUB_SIGNER_UNTRUSTED');
  verifyHubPackage(bundle.manifest, bundle.envelope, bundle.files, keys);
  return keys;
}
export async function acceptClientFeed(store: HubClientStore, source: HubSource, input: unknown, nowMs: number, persist: boolean): Promise<HubRevocationFeed> {
  const previous = await store.feed(source.scopeId, source.hubId), same = isDeepStrictEqual(previous, input);
  const feed = verifyHubRevocationFeed(input, { hubId: source.hubId, key: { keyId: source.hubId, publicKey: source.publicKey, role: 'hub', active: true },
    nowMs, previous: same ? null : previous });
  if (persist && !same) await store.saveFeed(source.scopeId, feed);
  return feed;
}
export async function requirePackageNotRevoked(store: HubClientStore, source: HubSource, bundle: HubBundle, feed: HubRevocationFeed, installed = false): Promise<void> {
  const targets = [...bundle.envelope.signatures.map(s => ({ kind: 'key' as const, id: s.keyId })),
    { kind: 'publisher' as const, id: bundle.manifest.packageId.split('/')[0]! }, { kind: 'package-version' as const, id: `${bundle.manifest.packageId}@${bundle.manifest.version}` }];
  const entries = [...await store.revocations(source.scopeId, source.hubId, targets), ...feed.entries.filter(entry => targets.some(t => t.kind === entry.kind && t.id === entry.id))];
  if (entries.some(entry => !installed || entry.severity === 'revoke')) throw new HubClientError('HUB_PACKAGE_REVOKED');
}
export const higherHubVersion = (next: string, previous: string): boolean => {
  const a = next.split('.').map(BigInt), b = previous.split('.').map(BigInt);
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return a[index]! > b[index]!;
  return false;
};
