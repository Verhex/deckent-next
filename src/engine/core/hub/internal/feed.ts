import { canonicalHubJson, encodeCommandProjection, SIGNATURE_LABELS, HUB_LIMITS, HubError, hubRevocationFeedSchema, parseHubContract, type HubRevocationFeed, type HubRevocationCursor } from '#domain/index.js';
import { signatureMessage } from '#platform/index.js';
import { requireHubSignature, type HubVerificationKey } from './signatures.js';

export const hubRevocationFeedMessage = (feed: Omit<HubRevocationFeed, 'signature'>) => signatureMessage(SIGNATURE_LABELS.revocationFeed,
  encodeCommandProjection(SIGNATURE_LABELS.revocationFeed, feed));
export const hubRevocationCursorMessage = (cursor: Omit<HubRevocationCursor, 'signature'>) =>
  signatureMessage('hub-revocation-cursor:1', canonicalHubJson(cursor));
/** A page production sequence is not its snapshot watermark: writes may occur between pages. */
export const hubRevocationWatermark = (feed: HubRevocationFeed | null): number => feed?.catchup?.throughSequence ?? feed?.sequence ?? 0;
export function requireHubRevocationContinuation(feed: HubRevocationFeed, previous: HubRevocationFeed | null) {
  const page = feed.catchup, pending = previous?.catchup;
  if (pending && !pending.complete) {
    const next = pending.next!;
    if (page?.page === 0 && page.afterSequence === pending.afterSequence && page.throughSequence >= pending.throughSequence
      && feed.issuedAtMs >= Math.min(next.nextRefreshBy, next.issuedAtMs + HUB_LIMITS.feedMaxAgeMs)) return;
    if (!page || page.afterSequence !== next.afterSequence || page.throughSequence !== next.throughSequence || page.position !== next.position
      || page.throughPosition !== next.throughPosition || page.page !== next.page) throw new HubError('HUB_FEED_INVALID');
  } else if (page && (page.page !== 0 || page.afterSequence !== hubRevocationWatermark(previous))) throw new HubError('HUB_FEED_INVALID');
}
/** Pinned source id is independent of a delegated online feed key. The caller verifies that key's root delegation first. */
export function verifyHubRevocationFeed(input: unknown, context: { readonly hubId: string; readonly key: HubVerificationKey; readonly nowMs: number;
  readonly previous: Pick<HubRevocationFeed, 'hubId' | 'sequence' | 'issuedAtMs'> | null }): HubRevocationFeed {
  const feed = parseHubContract(hubRevocationFeedSchema, input, 'HUB_FEED_INVALID', 'HUB_FEED_SCHEMA_UNSUPPORTED');
  if (feed.hubId !== context.hubId || context.key.role !== 'hub') throw new HubError('HUB_IDENTITY_MISMATCH');
  const { signature, ...payload } = feed;
  requireHubSignature(context.key, signature.keyId, hubRevocationFeedMessage(payload), signature.value);
  if (feed.catchup && (feed.catchup.throughSequence >= feed.sequence || feed.catchup.next && feed.catchup.next.hubId !== feed.hubId
    || !feed.catchup.complete && feed.entries.length === 0)) throw new HubError('HUB_FEED_INVALID');
  if (!Number.isSafeInteger(context.nowMs) || context.nowMs < 0 || (context.previous && context.previous.hubId !== context.hubId)) throw new HubError('HUB_FEED_INVALID');
  if (context.previous && (feed.sequence <= context.previous.sequence || feed.issuedAtMs < context.previous.issuedAtMs)) throw new HubError('HUB_FEED_REPLAYED');
  if (feed.issuedAtMs > context.nowMs || feed.nextRefreshBy <= context.nowMs || context.nowMs - feed.issuedAtMs >= HUB_LIMITS.feedMaxAgeMs)
    throw new HubError('HUB_FEED_STALE');
  return feed;
}
