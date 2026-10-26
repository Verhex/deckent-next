import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { canonicalHubJson, HUB_LIMITS } from '#domain/index.js';
import { ed25519KeyId, sha256, signatureMessage } from '#platform/index.js';
import { HubRevocationApplication } from './revocations.js';
import { HubServerError, type HubServerContext, type HubServerTransaction, type HubServerPorts } from './ports.js';
import { hubAccountSchema, hubProfileSchema, hubSessionSchema, hubServicePolicySchema,
  type HubProfile, type HubServiceArea, type HubServiceDependencies, type HubServiceTransaction } from './service-contract.js';

export class HubServiceBase extends HubRevocationApplication {
  readonly service: HubServiceDependencies;
  constructor(ports: HubServerPorts, dependencies: HubServiceDependencies) {
    super(ports);
    this.service = { ...dependencies, policy: hubServicePolicySchema.parse(dependencies.policy) };
    if (!ports.feedSigner || ed25519KeyId(Buffer.from(dependencies.rootPublicKey, 'base64')) !== ports.hubId) throw new HubServerError('HUB_STORE_UNSAFE');
  }
  protected override async signer(now: number, purpose: 'attestation' | 'feed' = 'attestation') {
    const online = await super.signer(now, purpose);
    const other = await super.signer(now, purpose === 'feed' ? 'attestation' : 'feed');
    if (online.key.keyId === this.ports.hubId || other.key.keyId === this.ports.hubId || online.key.keyId === other.key.keyId) throw new HubServerError('HUB_STORE_UNSAFE');
    return online;
  }
  async recordRevocations(tx: HubServerTransaction, entries: Parameters<HubServiceBase['signFeed']>[1]) {
    const { feed, signer, now } = await this.signFeed(tx, entries);
    await tx.appendReceipt({ action: entries.some(e => e.severity === 'revoke') ? 'revoke' : 'yank',
      context: { scopeId: this.ports.scopeId, principal: { kind: 'system', id: this.ports.hubId } }, resource: this.ports.hubId,
      digest: sha256(canonicalHubJson(feed)), atMs: now, feed }, signer); return feed;
  }
  attestation(atMs: number) { return this.signer(atMs); }
  data(tx: HubServerTransaction): HubServiceTransaction {
    if (!tx.service) throw new HubServerError('HUB_STORE_UNSUPPORTED');
    return tx.service;
  }
  *rows(data: HubServiceTransaction, area: HubServiceArea) {
    let after = '';
    for (;;) {
      const page = data.list(area, after, HUB_LIMITS.searchPageMax);
      for (const row of page) yield row;
      if (page.length < HUB_LIMITS.searchPageMax) break;
      after = page.at(-1)!.id;
    }
  }
  opaque() { return randomBytes(32).toString('hex'); }
  account(tx: HubServerTransaction, context: HubServerContext, appealOnly = false) {
    if (context.scopeId !== this.ports.scopeId || context.principal.kind !== 'person' || !context.sessionId
      || !this.data(tx).get('sessions', context.sessionId)) throw new HubServerError('HUB_SERVER_DENIED');
    const session = hubSessionSchema.parse(this.data(tx).get('sessions', context.sessionId));
    const account = hubAccountSchema.parse(this.data(tx).get('accounts', session.accountId));
    if (context.scopeId !== this.ports.scopeId || context.principal.kind !== 'person' || context.principal.id !== account.id
      || session.expiresAtMs <= this.clock() || account.status === 'deleted' || !appealOnly && account.status !== 'active') throw new HubServerError('HUB_SERVER_DENIED');
    return account;
  }
  async session(token: string, appealOnly = false): Promise<HubServerContext> {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new HubServerError('HUB_SERVER_DENIED');
    return this.ports.store.transaction(async tx => {
      const sessionId = sha256(token), session = hubSessionSchema.parse(this.data(tx).get('sessions', sessionId));
      const context = { scopeId: this.ports.scopeId, principal: { kind: 'person' as const, id: session.accountId }, sessionId };
      this.account(tx, context, appealOnly); return context;
    });
  }
  admin(tx: HubServerTransaction, context: HubServerContext) {
    const account = this.account(tx, context);
    if (!this.service.policy.admins.includes(account.id)) throw new HubServerError('HUB_SERVER_DENIED');
    return account;
  }
  async change<T>(context: HubServerContext, action: 'register' | 'review' | 'operate' | 'read', resource: string, input: unknown,
    work: (tx: HubServerTransaction) => Promise<T>, signal?: AbortSignal, appealOnly = false): Promise<T> {
    const digest = sha256(canonicalHubJson(input));
    return this.ports.store.transaction(async tx => {
      signal?.throwIfAborted(); this.account(tx, context, appealOnly);
      await this.authorize(context, action, resource, digest);
      const result = await work(tx);
      await this.authorize(context, action, resource, digest); signal?.throwIfAborted();
      return result;
    });
  }
  limit(tx: HubServerTransaction, actor: string, action: string, max: number, windowMs: number) {
    const data = this.data(tx), now = this.clock(), bucket = Math.floor(now / windowMs), id = sha256(canonicalHubJson({ actor, action, bucket }));
    const schema = z.object({ count: z.number().int().nonnegative(), expiresAtMs: z.number().int().nonnegative() }).strict();
    const current = data.get('rates', id), count = current ? schema.parse(current).count : 0;
    if (count >= max) throw new HubServerError('HUB_RATE_REFUSED');
    data.put('rates', id, { count: count + 1, expiresAtMs: (bucket + 1) * windowMs });
  }
  async log(tx: HubServerTransaction, actor: string, action: string, resource: string, reason: string | null = null, publicEntry = false) {
    const now = this.clock(), { signer } = await this.signer(now);
    return this.data(tx).audit({ actor, action, resource, reason, atMs: now }, this.service.integrity, signer, publicEntry);
  }
  profile(tx: HubServerTransaction, id: string): HubProfile { return hubProfileSchema.parse(this.data(tx).get('profiles', id)); }
  async saveProfile(tx: HubServerTransaction, profile: Omit<HubProfile, 'signature'>) {
    const payload = hubProfileSchema.omit({ signature: true }).strip().parse(profile), { signer } = await this.signer(this.clock());
    const signature = { keyId: signer.keyId, value: Buffer.from(await signer.sign(signatureMessage('hub-profile:1', canonicalHubJson({ hubId: this.ports.hubId, ...payload })))).toString('base64') };
    const signed = hubProfileSchema.parse({ ...payload, signature });
    this.data(tx).put('profiles', profile.id, signed); return signed;
  }
}
