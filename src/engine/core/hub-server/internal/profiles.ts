import { z } from 'zod';
import { canonicalHubJson, identitySchema } from '#domain/index.js';
import { ed25519KeyId, signatureMessage } from '#platform/index.js';
import { requireHubSignature } from '#engine/core/hub/index.js';
import { HubServerError, hubRegisteredKeySchema, type HubServerContext } from './ports.js';
import { hubChallengeSchema, hubRecoverySchema, hubProfileSchema, hubRosterSchema, type HubProfile } from './service-contract.js';
import type { HubServiceBase } from './service-base.js';

export const hubKeyProofMessage = (hubId: string, profileId: string, challenge: string, key: unknown) =>
  signatureMessage('hub-key-proof:1', canonicalHubJson({ hubId, profileId, challenge, key }));
export const hubRosterMessage = (input: unknown) => {
  const { signature: _signature, ...payload } = hubRosterSchema.parse(input);
  void _signature;
  return signatureMessage('hub-moderator-roster:1', canonicalHubJson(payload));
};
export class HubProfiles {
  constructor(private readonly app: HubServiceBase) {}
  private owner(profile: HubProfile, context: HubServerContext) {
    if (profile.status !== 'active' || !profile.members.some(member => member.accountId === context.principal.id && member.role === 'owner')) throw new HubServerError('HUB_SERVER_DENIED');
  }
  async create(context: HubServerContext, input: unknown, signal?: AbortSignal) {
    const app = this.app, command = hubProfileSchema.omit({ id: true, members: true, keys: true, status: true, sequence: true,
      verifiedDomains: true, recoveryReview: true, signature: true }).strict().parse(input);
    return app.change(context, 'register', 'profile', command, async tx => {
      const policy = app.service.policy;
      const skeleton = (text: string) => [...text].map(char => policy.confusables[char] ?? char).join('');
      if (policy.reservedHandles.some(handle => skeleton(handle) === skeleton(command.handle))) throw new HubServerError('HUB_PROFILE_REFUSED');
      for (const row of app.rows(app.data(tx), 'profiles')) if (skeleton(app.profile(tx, row.id).handle) === skeleton(command.handle)) throw new HubServerError('HUB_PROFILE_REFUSED');
      const id = app.opaque(), profile = await app.saveProfile(tx, { ...command, id, members: [{ accountId: context.principal.id, role: 'owner' }],
        keys: [], verifiedDomains: [], status: 'active', sequence: 1, recoveryReview: false });
      await app.log(tx, context.principal.id, 'profile-create', id); return profile;
    }, signal);
  }
  async members(context: HubServerContext, profileId: string, input: unknown, signal?: AbortSignal) {
    const app = this.app, members = hubProfileSchema.shape.members.max(app.service.policy.maxMembers).parse(input);
    return app.change(context, 'register', profileId, { members }, async tx => {
      const profile = app.profile(tx, profileId); this.owner(profile, context);
      if (!members.some(m => m.role === 'owner') || new Set(members.map(m => m.accountId)).size !== members.length) throw new HubServerError('HUB_PROFILE_REFUSED');
      for (const member of members) {
        const account = app.data(tx).get('accounts', member.accountId) as { status?: unknown } | null;
        if (account?.status !== 'active') throw new HubServerError('HUB_ACCOUNT_REFUSED');
      }
      // Removing a member cannot silently keep that member's publishing authority.
      const keys = profile.keys.map(key => key.memberAccountId && !members.some(m => m.accountId === key.memberAccountId) ? { ...key, state: 'revoked' as const } : key);
      const revoked = keys.filter(key => key.state === 'revoked' && profile.keys.find(old => old.keyId === key.keyId)?.state === 'active');
      for (const key of revoked) {
        const registered = await tx.key(key.keyId, 'publisher'); if (registered) await tx.putKey({ ...registered, active: false });
      }
      for (const key of revoked) await app.recordRevocations(tx, [{ kind: 'key', id: key.keyId, severity: 'revoke', reason: 'profile-membership', atMs: app.ports.now() }]);
      const result = await app.saveProfile(tx, { ...profile, members, keys, sequence: profile.sequence + 1 });
      await app.log(tx, context.principal.id, 'profile-members', profile.id); return result;
    }, signal);
  }
  async keyChallenge(context: HubServerContext, profileId: string, input: unknown, signal?: AbortSignal) {
    const app = this.app, key = hubRegisteredKeySchema.parse(input);
    return app.change(context, 'register', profileId, { key }, async tx => {
      const profile = app.profile(tx, profileId); this.owner(profile, context);
      if (key.role !== 'publisher' || key.publisherId !== `@${profile.handle}` || !key.active || key.trustedAiReviewer
        || ed25519KeyId(Buffer.from(key.publicKey, 'base64')) !== key.keyId
        || key.principal.kind === 'person' && !profile.members.some(m => m.accountId === key.principal.id)) throw new HubServerError('HUB_PROFILE_REFUSED');
      app.limit(tx, context.principal.id, 'key-challenge', app.service.policy.maxChallenges, app.service.policy.challengeTtlMs);
      const challenge = { id: app.opaque(), accountId: context.principal.id, purpose: 'key' as const,
        binding: canonicalHubJson({ profileId, key }), expiresAtMs: app.ports.now() + app.service.policy.challengeTtlMs };
      app.data(tx).put('challenges', challenge.id, challenge); return challenge;
    }, signal);
  }
  async addKey(context: HubServerContext, profileId: string, challengeId: string, signature: string, signal?: AbortSignal) {
    const app = this.app;
    return app.change(context, 'register', profileId, { challengeId, signature }, async tx => {
      const data = app.data(tx), profile = app.profile(tx, profileId); this.owner(profile, context);
      const challenge = hubChallengeSchema.parse(data.get('challenges', challengeId));
      if (challenge.purpose !== 'key' || challenge.accountId !== context.principal.id || challenge.expiresAtMs <= app.ports.now()) throw new HubServerError('HUB_PROFILE_REFUSED');
      const binding = z.object({ profileId: identitySchema, key: hubRegisteredKeySchema }).strict().parse(JSON.parse(challenge.binding));
      const key = binding.key;
      if (binding.profileId !== profileId || profile.keys.length >= app.service.policy.maxKeys || await tx.key(key.keyId, 'publisher')
        || key.principal.kind === 'person' && !profile.members.some(m => m.accountId === key.principal.id)) throw new HubServerError('HUB_PROFILE_REFUSED');
      requireHubSignature(key, key.keyId, hubKeyProofMessage(app.ports.hubId, profileId, challenge.id, key), signature);
      data.remove('challenges', challengeId); await tx.putKey(key);
      const result = await app.saveProfile(tx, { ...profile, sequence: profile.sequence + 1, keys: [...profile.keys, { keyId: key.keyId, publicKey: key.publicKey,
        principalId: key.principal.id, principalKind: key.principal.kind, memberAccountId: key.principal.kind === 'person' ? key.principal.id : null,
        addedAtMs: app.ports.now(), state: 'active' }] });
      await app.log(tx, context.principal.id, 'profile-key', key.keyId); return result;
    }, signal);
  }
  async requestRecovery(context: HubServerContext, profileId: string, challengeId: string, lostKeyId: string, signature: string, signal?: AbortSignal) {
    const app = this.app;
    return app.change(context, 'register', profileId, { challengeId, lostKeyId, signature }, async tx => {
      const profile = app.profile(tx, profileId); this.owner(profile, context);
      const challenge = hubChallengeSchema.parse(app.data(tx).get('challenges', challengeId));
      if (challenge.purpose !== 'key' || challenge.accountId !== context.principal.id || challenge.expiresAtMs <= app.ports.now()) throw new HubServerError('HUB_PROFILE_REFUSED');
      const binding = z.object({ profileId: identitySchema, key: hubRegisteredKeySchema }).strict().parse(JSON.parse(challenge.binding));
      const lost = profile.keys.find(key => key.keyId === lostKeyId && key.state === 'active');
      if (profile.keys.length >= app.service.policy.maxKeys || binding.profileId !== profileId || !lost || binding.key.principal.id !== lost.principalId || binding.key.principal.kind !== lost.principalKind
        || binding.key.publisherId !== `@${profile.handle}` || await tx.key(binding.key.keyId, 'publisher')) throw new HubServerError('HUB_PROFILE_REFUSED');
      requireHubSignature(binding.key, binding.key.keyId, hubKeyProofMessage(app.ports.hubId, profileId, challengeId, binding.key), signature);
      const record = hubRecoverySchema.parse({ id: app.opaque(), profileId, accountId: context.principal.id, lostKeyId, key: binding.key, approved: false });
      app.data(tx).remove('challenges', challengeId); app.data(tx).put('recoveries', record.id, record);
      await app.log(tx, context.principal.id, 'recovery-request', record.id); return record;
    }, signal);
  }
  async domainChallenge(context: HubServerContext, profileId: string, domain: string, signal?: AbortSignal) {
    const app = this.app;
    if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain) || domain.length > 253) throw new HubServerError('HUB_PROFILE_REFUSED');
    return app.change(context, 'register', profileId, { domain }, async tx => {
      this.owner(app.profile(tx, profileId), context);
      const challenge = { id: app.opaque(), accountId: context.principal.id, purpose: 'domain' as const,
        binding: canonicalHubJson({ profileId, domain }), expiresAtMs: app.ports.now() + app.service.policy.challengeTtlMs };
      app.data(tx).put('challenges', challenge.id, challenge); return { challengeId: challenge.id, txt: `deckent-hub-verify=${challenge.id}` };
    }, signal);
  }
  async verifyDomain(context: HubServerContext, profileId: string, challengeId: string, signal?: AbortSignal) {
    const app = this.app;
    return app.change(context, 'register', profileId, { challengeId }, async tx => {
      const profile = app.profile(tx, profileId); this.owner(profile, context);
      const challenge = hubChallengeSchema.parse(app.data(tx).get('challenges', challengeId));
      const binding = z.object({ profileId: identitySchema, domain: z.string() }).strict().parse(JSON.parse(challenge.binding));
      if (challenge.purpose !== 'domain' || challenge.accountId !== context.principal.id || binding.profileId !== profileId || challenge.expiresAtMs <= app.ports.now()
        || !await app.service.verifyDomain(binding.domain, `deckent-hub-verify=${challenge.id}`, signal) || challenge.expiresAtMs <= app.ports.now()) throw new HubServerError('HUB_PROFILE_REFUSED');
      app.data(tx).remove('challenges', challengeId);
      const result = await app.saveProfile(tx, { ...profile, verifiedDomains: [...new Set([...profile.verifiedDomains, binding.domain])], sequence: profile.sequence + 1 });
      await app.log(tx, context.principal.id, 'profile-domain', profileId); return result;
    }, signal);
  }
  async roster(context: HubServerContext, input: unknown, signal?: AbortSignal) {
    const app = this.app, roster = hubRosterSchema.parse(input);
    return app.change(context, 'register', 'roster', roster, async tx => {
      app.admin(tx, context); const existing = app.data(tx).get('roster', app.ports.hubId);
      if (roster.hubId !== app.ports.hubId || existing && hubRosterSchema.parse(existing).sequence >= roster.sequence
        || new Set(roster.entries.map(e => e.keyId)).size !== roster.entries.length || roster.entries.some(e => e.notAfter <= e.notBefore)) throw new HubServerError('HUB_REVIEW_REFUSED');
      requireHubSignature({ keyId: app.ports.hubId, publicKey: app.service.rootPublicKey, role: 'hub', active: true }, roster.signature.keyId, hubRosterMessage(roster), roster.signature.value);
      for (const entry of roster.entries) {
        if (ed25519KeyId(Buffer.from(entry.publicKey, 'base64')) !== entry.keyId || !app.data(tx).get('accounts', entry.accountRef)) throw new HubServerError('HUB_REVIEW_REFUSED');
        await tx.putKey({ keyId: entry.keyId, publicKey: entry.publicKey, principal: { id: entry.accountRef, kind: 'person' }, role: 'reviewer', active: true, trustedAiReviewer: false });
      }
      app.data(tx).put('roster', app.ports.hubId, roster); await app.log(tx, context.principal.id, 'roster', app.ports.hubId); return roster;
    }, signal);
  }
}
