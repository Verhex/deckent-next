import { z } from 'zod';
import { canonicalHubJson, HUB_LIMITS } from '#domain/index.js';
import { sha256 } from '#platform/index.js';
import { HubServerError, type HubServerContext } from './ports.js';
import { hubAccountSchema, hubChallengeSchema, hubPersonalSchema, hubSessionSchema } from './service-contract.js';
import type { HubServiceBase } from './service-base.js';

export class HubAccounts {
  constructor(private readonly app: HubServiceBase) {}
  async begin(providerId: string, addressId: string) {
    const app = this.app, provider = app.service.policy.identityProviders.find(row => row.id === providerId);
    if (!provider || !/^[a-f0-9]{64}$/.test(addressId)) throw new HubServerError('HUB_ACCOUNT_REFUSED');
    return app.ports.store.transaction(async tx => {
      app.limit(tx, addressId, 'login', app.service.policy.maxChallenges, app.service.policy.challengeTtlMs);
      const challenge = { id: app.opaque(), accountId: null, purpose: 'login' as const, binding: providerId, expiresAtMs: app.ports.now() + app.service.policy.challengeTtlMs };
      app.data(tx).put('challenges', challenge.id, challenge); return challenge;
    });
  }
  async login(challengeId: string, input: unknown, signal?: AbortSignal) {
    const app = this.app;
    // Read the one-time challenge before invoking the trusted IdP adapter; consume it under the writer lock afterwards.
    const challenge = await app.ports.store.transaction(async tx => hubChallengeSchema.parse(app.data(tx).get('challenges', challengeId)));
    const provider = app.service.policy.identityProviders.find(row => row.id === challenge.binding), now = app.ports.now();
    if (!provider || challenge.purpose !== 'login' || challenge.expiresAtMs <= now) throw new HubServerError('HUB_ACCOUNT_REFUSED');
    signal?.throwIfAborted();
    const identity = await app.service.identity.verify(input, { challenge: challenge.id, issuer: provider.issuer, audience: provider.audience, nowMs: now });
    if (!identity.emailVerified || !identity.passkeyVerified) throw new HubServerError('HUB_ACCOUNT_REFUSED');
    const accountId = app.service.integrity.sign(canonicalHubJson({ provider: provider.id, subject: identity.subject }));
    const personal = hubPersonalSchema.parse({ accountId, providerId: provider.id, subject: identity.subject, email: identity.email, displayName: identity.displayName });
    return app.ports.store.transaction(async tx => {
      signal?.throwIfAborted(); const data = app.data(tx);
      if (canonicalHubJson(data.get('challenges', challenge.id)) !== canonicalHubJson(challenge) || challenge.expiresAtMs <= app.ports.now()) throw new HubServerError('HUB_ACCOUNT_REFUSED');
      const existing = data.get('accounts', accountId), account = existing ? hubAccountSchema.parse(existing)
        : hubAccountSchema.parse({ schemaVersion: 1, id: accountId, createdAtMs: app.ports.now(), status: 'active', deleteAfterMs: null });
      if (account.status === 'deleted') throw new HubServerError('HUB_ACCOUNT_REFUSED');
      data.remove('challenges', challenge.id); data.put('accounts', accountId, account); data.put('personal', accountId, personal);
      const token = app.opaque(), session = { id: sha256(token), accountId, expiresAtMs: app.ports.now() + app.service.policy.sessionTtlMs };
      data.put('sessions', session.id, session); await app.log(tx, accountId, existing ? 'login' : 'account-create', accountId);
      signal?.throwIfAborted(); return { accountId, token, expiresAtMs: session.expiresAtMs, appealOnly: account.status !== 'active' };
    });
  }
  async logout(context: HubServerContext, signal?: AbortSignal) {
    return this.app.change(context, 'operate', context.principal.id, { operation: 'account.logout', sessionId: context.sessionId }, async tx => {
      this.app.data(tx).remove('sessions', context.sessionId!);
      return this.app.log(tx, context.principal.id, 'logout', context.principal.id);
    }, signal);
  }
  async remove(context: HubServerContext, signal?: AbortSignal) {
    const app = this.app;
    return app.change(context, 'operate', context.principal.id, { operation: 'account.delete' }, async tx => {
      const account = app.account(tx, context);
      for (const row of app.rows(app.data(tx), 'profiles')) {
        const profile = app.profile(tx, row.id);
        if (profile.status === 'active' && profile.members.some(m => m.accountId === account.id && m.role === 'owner')) throw new HubServerError('HUB_ACCOUNT_REFUSED');
      }
      app.data(tx).put('accounts', account.id, { ...account, status: 'deleted', deleteAfterMs: app.ports.now() + app.service.policy.deletionDelayMs });
      return app.log(tx, account.id, 'account-delete', account.id);
    }, signal);
  }
  async maintain(context: HubServerContext, signal?: AbortSignal) {
    const app = this.app;
    return app.change(context, 'operate', 'maintenance', { operation: 'account.maintain' }, async tx => {
      app.admin(tx, context); const data = app.data(tx), now = app.ports.now(); let deleted = 0;
      for (const row of app.rows(data, 'accounts')) {
        const account = hubAccountSchema.parse(row.value);
        if (account.status === 'deleted' && account.deleteAfterMs !== null && account.deleteAfterMs <= now && data.get('personal', account.id)) {
          data.remove('personal', account.id); deleted++;
        }
      }
      for (const area of ['sessions', 'challenges', 'rates'] as const) for (const row of app.rows(data, area)) {
        const expires = area === 'sessions' ? hubSessionSchema.parse(row.value).expiresAtMs : area === 'challenges' ? hubChallengeSchema.parse(row.value).expiresAtMs
          : z.object({ expiresAtMs: z.number() }).parse(row.value).expiresAtMs;
        if (expires <= now) data.remove(area, row.id);
      }
      await app.log(tx, context.principal.id, 'retention', sha256(String(deleted))); return { deleted };
    }, signal);
  }
  async audit(context: HubServerContext, after = 0, limit = HUB_LIMITS.searchPageMax, signal?: AbortSignal) {
    const app = this.app;
    return app.change(context, 'read', 'audit', { after, limit }, async tx => { app.admin(tx, context); return app.data(tx).auditPage(after, limit, app.service.integrity); }, signal);
  }
}
