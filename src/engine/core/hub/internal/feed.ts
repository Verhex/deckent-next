import { encodeCommandProjection, SIGNATURE_LABELS, HUB_LIMITS, HubError, hubRevocationFeedSchema, parseHubContract, type HubRevocationFeed } from '#domain/index.js';
import { signatureMessage } from '#platform/index.js';
import { requireHubSignature, type HubVerificationKey } from './signatures.js';

export const hubRevocationFeedMessage = (feed: Omit<HubRevocationFeed, 'signature'>) => signatureMessage(SIGNATURE_LABELS.revocationFeed,
  encodeCommandProjection(SIGNATURE_LABELS.revocationFeed, feed));
/** Pinned source id is independent of a delegated online feed key. The caller verifies that key's root delegation first. */
export function verifyHubRevocationFeed(input: unknown, context: { readonly hubId: string; readonly key: HubVerificationKey; readonly nowMs: number;
  readonly previous: Pick<HubRevocationFeed, 'hubId' | 'sequence' | 'issuedAtMs'> | null }): HubRevocationFeed {
  const feed = parseHubContract(hubRevocationFeedSchema, input, 'HUB_FEED_INVALID', 'HUB_FEED_SCHEMA_UNSUPPORTED');
  if (feed.hubId !== context.hubId || context.key.role !== 'hub') throw new HubError('HUB_IDENTITY_MISMATCH');
  const { signature, ...payload } = feed;
  requireHubSignature(context.key, signature.keyId, hubRevocationFeedMessage(payload), signature.value);
  if (!Number.isSafeInteger(context.nowMs) || context.nowMs < 0 || (context.previous && context.previous.hubId !== context.hubId)) throw new HubError('HUB_FEED_INVALID');
  if (context.previous && (feed.sequence <= context.previous.sequence || feed.issuedAtMs < context.previous.issuedAtMs)) throw new HubError('HUB_FEED_REPLAYED');
  if (feed.issuedAtMs > context.nowMs || feed.nextRefreshBy <= context.nowMs || context.nowMs - feed.issuedAtMs >= HUB_LIMITS.feedMaxAgeMs)
    throw new HubError('HUB_FEED_STALE');
  return feed;
}
