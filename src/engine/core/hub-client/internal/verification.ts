import { isDeepStrictEqual } from 'node:util';
import { HUB_TRUST_POLICIES, HubError, type HubRevocationFeed, type VerifiedPrincipal } from '#domain/index.js';
import { ed25519KeyId } from '#platform/index.js';
import { delegatedHubKey, hubFeedKey, hubKeyRevoked, verifyHubPackage, verifyHubRevocationFeed, requireHubRevocationContinuation, type HubVerificationKey } from '#engine/core/hub/index.js';
import { HubClientError, type HubBundle, type HubClientDependencies, type HubClientStore, type HubSource, type HubClientTrust } from './contract.js';
/** The scope's local signer revocations (S8-5 log), the second revocation source every client path checks beside the hub's entries. */
export const localRevokedKeyIds = async (deps: HubClientDependencies, scopeId: string) =>
  (deps.catalog.revocations ? await deps.catalog.revocations.list() : []).filter(row => row.scopeId === scopeId).map(row => row.keyId);
/** Every trust resolver is a trusted composition port; publisher-pinned is resolved here from the current scope's signer rows.
 * `stored`: re-verifying a bundle this installation verified and stored earlier (a historical hub signature time still counts). */
export async function verifyClientBundle(deps: HubClientDependencies, store: HubClientStore, source: HubSource, bundle: HubBundle, principal: VerifiedPrincipal, stored = false): Promise<HubClientTrust> {
  const nowMs = deps.catalog.now(), publisherId = bundle.envelope.signatures.find(s => s.role === 'publisher')?.keyId;
  const policy = HUB_TRUST_POLICIES.policies.find(p => p.id === source.trustPolicy)!;
  // The pinned root, or the online attestation key it delegated at the hub signature's time; never a key the trust resolver names on its own.
  if (ed25519KeyId(Buffer.from(source.publicKey, 'base64')) !== source.hubId) throw new HubError('HUB_IDENTITY_MISMATCH');
  const attestation = bundle.envelope.signatures.find(s => s.role === 'hub'), root = { hubId: source.hubId, publicKey: source.publicKey };
  const hub = attestation ? delegatedHubKey(root, attestation.keyId, bundle.delegation, 'attestation', attestation.signedAtMs, { nowMs, stored })
    : { keyId: source.hubId, publicKey: source.publicKey, role: 'hub' as const, active: true };
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
      hub, reviewers };
  } else {
    if (!deps.resolveTrust) throw new HubError('HUB_SIGNER_UNTRUSTED');
    keys = await deps.resolveTrust(source, bundle, principal, store, nowMs);
  }
  if (!keys.hub || keys.hub.publicKey !== hub.publicKey || keys.hub.keyId !== hub.keyId) throw new HubError('HUB_IDENTITY_MISMATCH');
  if (deps.resolveTrust && policy.publisherPinned && policy.reviewers === 'none' && !policy.moderation) {
    const resolved = await deps.resolveTrust(source, bundle, principal, store, nowMs);
    if (resolved.publisher.keyId !== keys.publisher.keyId || resolved.publisher.publicKey !== keys.publisher.publicKey) throw new HubError('HUB_SIGNER_UNTRUSTED');
    keys = { ...keys, ...(resolved.publisherKind ? { publisherKind: resolved.publisherKind } : {}) };
  }
  const local = await localRevokedKeyIds(deps, source.scopeId);
  if ([keys.publisher.keyId, hub.keyId, ...keys.reviewers.map(k => k.keyId)].some(keyId => hubKeyRevoked(keyId, [], local))) throw new HubError('HUB_SIGNER_UNTRUSTED');
  // A new bundle's delegated attestation key must not be named by this hub's accepted revocation entries either (installed content keeps the
  // yank/revoke rule of requirePackageNotRevoked).
  if (!stored && hub.keyId !== source.hubId && hubKeyRevoked(hub.keyId, await store.revocations(source.scopeId, source.hubId, [{ kind: 'key', id: hub.keyId }]), local))
    throw new HubError('HUB_SIGNER_UNTRUSTED');
  verifyHubPackage(bundle.manifest, bundle.envelope, bundle.files, keys);
  return keys;
}
/** The pinned root or its feed key delegated now, refused once revoked by this hub (accepted entries or this feed) or locally for the scope. */
export async function clientFeedKey(deps: HubClientDependencies, store: HubClientStore, source: HubSource, input: unknown): Promise<HubVerificationKey> {
  const key = hubFeedKey({ hubId: source.hubId, publicKey: source.publicKey }, input, deps.catalog.now()), feed = input as HubRevocationFeed;
  if (key.keyId !== source.hubId && hubKeyRevoked(key.keyId, [...await store.revocations(source.scopeId, source.hubId, [{ kind: 'key', id: key.keyId }]), ...feed.entries],
    await localRevokedKeyIds(deps, source.scopeId))) throw new HubError('HUB_SIGNER_UNTRUSTED');
  return key;
}
export async function acceptClientFeed(deps: HubClientDependencies, store: HubClientStore, source: HubSource, input: unknown, persist: boolean): Promise<HubRevocationFeed> {
  const previous = await store.feed(source.scopeId, source.hubId), same = isDeepStrictEqual(previous, input), nowMs = deps.catalog.now();
  const feed = verifyHubRevocationFeed(input, { hubId: source.hubId, key: await clientFeedKey(deps, store, source, input), nowMs, previous: same ? null : previous });
  if (!same) requireHubRevocationContinuation(feed, previous);
  if (persist && !same) await store.saveFeed(source.scopeId, feed);
  return feed;
}
export async function requirePackageNotRevoked(store: HubClientStore, source: HubSource, bundle: HubBundle, feed: HubRevocationFeed, installed = false): Promise<void> {
  if (feed.catchup && !feed.catchup.complete) throw new HubError('HUB_FEED_INVALID');
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
