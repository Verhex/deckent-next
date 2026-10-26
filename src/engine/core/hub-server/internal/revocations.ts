import { z } from 'zod';
import { HUB_LIMITS, HUB_REVOCATION_REFRESH_MS, HubError, canonicalHubJson, counterSchema, identitySchema, hubRevocationEntrySchema, hubFeedSignatureSchema, hubRevocationCursorSchema, type HubRevocationFeed, type HubRevocationCursor } from '#domain/index.js';
import { sha256, signatureMessage } from '#platform/index.js';
import { hubRevocationFeedMessage, hubRevocationCursorMessage, requireHubSignature, verifyHubRevocationFeed } from '#engine/core/hub/index.js';
import { HubServerApplication } from './application.js';
import { HubServerError, type HubServerContext, type HubServerTransaction } from './ports.js';

const entrySchema = hubRevocationEntrySchema.unwrap().omit({ atMs: true, severity: true });
const commandSchema = entrySchema.extend({ schemaVersion: z.literal(1), commandId: identitySchema,
  authority: z.enum(['publisher', 'operator']), keyId: z.string().regex(/^[a-f0-9]{64}$/).optional(), signature: hubFeedSignatureSchema.unwrap().shape.value.optional() }).strict();
/** Versioned, principal/scope/hub/action-bound bytes; a transport identity alone cannot exercise a publisher key. */
export const hubRevocationRequestMessage = (hubId: string, context: HubServerContext, severity: 'yank' | 'revoke', input: Omit<z.infer<typeof commandSchema>, 'signature'>) =>
  signatureMessage('hub-revocation-request:1', canonicalHubJson({ hubId, context, severity, command: input }));

/** Feed snapshots live in the existing signed, append-only Hub receipt chain; no second database or transition owner. */
export class HubRevocationApplication extends HubServerApplication {
  private async requireOwner(store: HubServerTransaction, context: HubServerContext, command: z.infer<typeof commandSchema>, severity: 'yank' | 'revoke') {
    const { signature, ...payload } = command;
    if (command.authority === 'operator') {
      if (context.principal.kind !== 'person') throw new HubServerError('HUB_SERVER_DENIED');
      await this.authorize(context, 'operate', command.id, sha256(hubRevocationRequestMessage(this.ports.hubId, context, severity, payload)));
      return;
    }
    const key = await this.registered(command.keyId ?? '', 'publisher', store); this.bound(context, key);
    if (!signature) throw new HubServerError('HUB_SERVER_DENIED');
    requireHubSignature(key, key.keyId, hubRevocationRequestMessage(this.ports.hubId, context, severity, payload), signature);
    if (command.kind === 'key' && command.id === key.keyId) return;
    if (command.kind === 'package-version') {
      const at = command.id.lastIndexOf('@'), row = await this.requireVersion(command.id.slice(0, at), command.id.slice(at + 1), store);
      if (at > 0 && row.manifest.packageId.split('/')[0] === key.publisherId) return;
    }
    throw new HubServerError('HUB_SERVER_DENIED');
  }
  protected async signFeed(store: HubServerTransaction, entries: HubRevocationFeed['entries'], catchup?: HubRevocationFeed['catchup']) {
    const previous = await store.latestFeed(), now = this.clock(), { signer, key } = await this.signer(now, 'feed'), delegation = await this.delegationOf(key.keyId);
    if (previous && now < previous.issuedAtMs) throw new HubError('HUB_FEED_REPLAYED');
    const payload = { schemaVersion: 1 as const, hubId: this.ports.hubId, sequence: (previous?.sequence ?? 0) + 1,
      issuedAtMs: now, nextRefreshBy: now + HUB_REVOCATION_REFRESH_MS, entries, ...(catchup ? { catchup } : {}), ...(delegation ? { delegation } : {}) };
    const feed = { ...payload, signature: { keyId: signer.keyId, algorithm: 'ed25519' as const,
      value: Buffer.from(await signer.sign(hubRevocationFeedMessage(payload))).toString('base64') } };
    verifyHubRevocationFeed(feed, { hubId: this.ports.hubId, key, nowMs: now, previous });
    return { feed, signer, now };
  }
  async withdraw(context: HubServerContext, severity: 'yank' | 'revoke', input: unknown, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const command = commandSchema.parse(input), digest = sha256(canonicalHubJson({ context, severity, command }));
    return this.ports.store.transaction(async store => {
      signal?.throwIfAborted();
      await this.authorize(context, severity, command.id, digest);
      await this.requireOwner(store, context, command, severity);
      const replay = await store.revocationReceipt(command.commandId);
      if (replay) {
        if (replay.digest !== digest) throw new HubServerError('HUB_STORE_CONFLICT');
        return { feed: replay.feed, replayed: true };
      }
      const { feed, signer, now } = await this.signFeed(store, [{ kind: command.kind, id: command.id, reason: command.reason, severity, atMs: this.clock() }]);
      signal?.throwIfAborted();
      const receipt = await store.appendReceipt({ action: severity, context, resource: command.id, digest, atMs: now, commandId: command.commandId, feed }, signer);
      await this.authorize(context, severity, command.id, digest);
      if (command.authority === 'operator') {
        const payload = { ...command }; delete payload.signature;
        await this.authorize(context, 'operate', command.id, sha256(hubRevocationRequestMessage(this.ports.hubId, context, severity, payload)));
      }
      signal?.throwIfAborted();
      return { feed, receipt, replayed: false };
    });
  }
  /** Cursor pins immutable history; page production sequences never advance the client's completed snapshot watermark. */
  async revocations(context: HubServerContext, input: unknown = {}, signal?: AbortSignal) {
    const query = z.object({ afterSequence: counterSchema.default(0), continuation: hubRevocationCursorSchema.optional() }).strict().parse(input);
    return this.ports.store.transaction(async store => {
      signal?.throwIfAborted();
      await this.authorize(context, 'read', 'revocations', '');
      const previous = await store.latestFeed();
      if (query.afterSequence > (previous?.sequence ?? 0)) throw new HubError('HUB_FEED_REPLAYED');
      const cursor = query.continuation, clock = this.clock(), attestor = await this.signer(clock, 'feed');
      if (cursor) {
        const { signature, ...payload } = cursor;
        requireHubSignature(attestor.key, signature.keyId, hubRevocationCursorMessage(payload), signature.value);
        if (cursor.hubId !== this.ports.hubId || cursor.afterSequence !== query.afterSequence || cursor.throughSequence > (previous?.sequence ?? 0)) throw new HubError('HUB_FEED_INVALID');
        if (cursor.issuedAtMs > clock || cursor.nextRefreshBy <= clock || clock - cursor.issuedAtMs >= HUB_LIMITS.feedMaxAgeMs) throw new HubError('HUB_FEED_STALE');
      }
      const throughSequence = cursor?.throughSequence ?? previous?.sequence ?? 0;
      const page = await store.revocationPage(query.afterSequence, throughSequence, cursor?.position, cursor?.throughPosition);
      let next: HubRevocationCursor | null = null;
      if (page.nextPosition !== null) {
        const payload = { schemaVersion: 1 as const, hubId: this.ports.hubId, afterSequence: query.afterSequence, throughSequence,
          position: page.nextPosition, throughPosition: page.throughPosition, page: (cursor?.page ?? 0) + 1,
          issuedAtMs: cursor?.issuedAtMs ?? clock, nextRefreshBy: cursor?.nextRefreshBy ?? clock + HUB_REVOCATION_REFRESH_MS };
        next = { ...payload, signature: { keyId: attestor.signer.keyId, algorithm: 'ed25519',
          value: Buffer.from(await attestor.signer.sign(hubRevocationCursorMessage(payload))).toString('base64') } };
      }
      const { feed, signer, now } = await this.signFeed(store, page.entries, { schemaVersion: 1, afterSequence: query.afterSequence, throughSequence,
        position: page.position, throughPosition: page.throughPosition, page: cursor?.page ?? 0, complete: next === null, next });
      await store.appendReceipt({ action: 'feed', context, resource: 'revocations', digest: sha256(canonicalHubJson(feed)), atMs: now, feed }, signer);
      await this.authorize(context, 'read', 'revocations', '');
      signal?.throwIfAborted();
      return feed;
    });
  }
}
