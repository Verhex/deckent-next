import { z } from 'zod';
import { canonicalHubJson, identitySchema, HUB_LIMITS } from '#domain/index.js';
import { ed25519KeyId, signatureMessage } from '#platform/index.js';
import { requireHubSignature } from '#engine/core/hub/index.js';
import { HubServerError, hubRegisteredKeySchema, type HubServerContext, type HubServerTransaction } from './ports.js';
import { hubInvitationSchema, hubChallengeSchema, hubRecoverySchema, hubProfileSchema, hubRosterSchema, type HubProfile } from './service-contract.js';
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
  private owner(tx: HubServerTransaction, profile: HubProfile, context: HubServerContext) {
    if (profile.status !== 'active' || !this.app.consented(tx, profile, context.principal.id) || !profile.members.some(member => member.accountId === context.principal.id && member.role === 'owner')) throw new HubServerError('HUB_SERVER_DENIED');
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
      app.data(tx).put('membership-consents', id, { schemaVersion: 1, profileId: id, createdAtMs: app.ports.now(),
        members: [{ accountId: context.principal.id, acceptedAtMs: app.ports.now() }] });
      await app.log(tx, context.principal.id, 'profile-create', id); return profile;
    }, signal);
  }
  async members(context: HubServerContext, profileId: string, input: unknown, signal?: AbortSignal) {
    const app = this.app, members = hubProfileSchema.shape.members.max(app.service.policy.maxMembers).parse(input);
    return app.change(context, 'register', profileId, { members }, async tx => {
      const profile = app.profile(tx, profileId); this.owner(tx, profile, context);
      if (!members.some(m => m.role === 'owner') || new Set(members.map(m => m.accountId)).size !== members.length) throw new HubServerError('HUB_PROFILE_REFUSED');
      app.limit(tx, context.principal.id, 'profile-membership', app.service.policy.maxChallenges, app.service.policy.challengeTtlMs);
      for (const member of members) {
        if (!app.consented(tx, profile, member.accountId) || !profile.members.some(old => old.accountId === member.accountId && old.role === member.role)) throw new HubServerError('HUB_PROFILE_REFUSED');
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
      const removed = profile.members.filter(m => !members.some(kept => kept.accountId === m.accountId)).map(m => m.accountId);
      for (const row of app.rows(app.data(tx), 'invitations')) {
        const invitation = hubInvitationSchema.parse(row.value);
        if (invitation.profileId === profileId && invitation.state === 'pending' && (removed.includes(invitation.accountId) || removed.includes(invitation.inviterId))) {
          app.data(tx).put('invitations', invitation.id, { ...invitation, state: 'cancelled', resolvedAtMs: app.ports.now() });
          await app.log(tx, context.principal.id, 'profile-invitation-cancelled', invitation.id);
        }
      }
      const consent = app.membershipConsent(tx, profile);
      app.data(tx).put('membership-consents', profile.id, { ...consent, members: consent.members.filter(m => members.some(kept => kept.accountId === m.accountId)) });
      const result = await app.saveProfile(tx, { ...profile, members, keys, sequence: profile.sequence + 1 });
      await app.log(tx, context.principal.id, 'profile-members', profile.id); return result;
    }, signal);
  }
  async invite(context: HubServerContext, profileId: string, input: unknown, signal?: AbortSignal) {
    const app = this.app, member = hubProfileSchema.shape.members.element.parse(input);
    return app.change(context, 'register', profileId, { operation: 'profile.invite', member }, async tx => {
      const profile = app.profile(tx, profileId); this.owner(tx, profile, context);
      if (profile.members.filter(m => app.consented(tx, profile, m.accountId)).length >= app.service.policy.maxMembers || app.consented(tx, profile, member.accountId)) throw new HubServerError('HUB_PROFILE_REFUSED');
      const account = z.object({ status: z.literal('active') }).passthrough().safeParse(app.data(tx).get('accounts', member.accountId));
      if (!account.success) throw new HubServerError('HUB_ACCOUNT_REFUSED');
      app.limit(tx, context.principal.id, 'profile-membership', app.service.policy.maxChallenges, app.service.policy.challengeTtlMs);
      for (const row of app.rows(app.data(tx), 'invitations')) {
        const old = hubInvitationSchema.parse(row.value);
        if (old.profileId === profileId && old.accountId === member.accountId && old.state === 'pending' && old.expiresAtMs > app.ports.now()) throw new HubServerError('HUB_PROFILE_REFUSED');
      }
      const now = app.ports.now(), invitation = hubInvitationSchema.parse({ schemaVersion: 1, id: app.opaque(), profileId,
        inviterId: context.principal.id, ...member, createdAtMs: now, expiresAtMs: now + app.service.policy.challengeTtlMs, state: 'pending', resolvedAtMs: null });
      app.data(tx).put('invitations', invitation.id, invitation);
      await app.log(tx, context.principal.id, 'profile-invite', invitation.id); return invitation;
    }, signal);
  }
  async invitations(context: HubServerContext, after = '', limit = HUB_LIMITS.searchPageMax, signal?: AbortSignal) {
    const app = this.app;
    return app.change(context, 'read', 'invitations', { after, limit }, async tx => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > HUB_LIMITS.searchPageMax || after.length > HUB_LIMITS.httpMaxBytes) throw new HubServerError('HUB_RATE_REFUSED');
      const result: z.infer<typeof hubInvitationSchema>[] = [];
      let cursor = after;
      for (;;) {
        const page = app.data(tx).list('invitations', cursor, HUB_LIMITS.searchPageMax);
        for (const row of page) {
          const invitation = hubInvitationSchema.parse(row.value); cursor = row.id;
          if (invitation.accountId === context.principal.id) result.push(invitation.state === 'pending' && invitation.expiresAtMs <= app.ports.now()
            ? { ...invitation, state: 'expired', resolvedAtMs: invitation.expiresAtMs } : invitation);
          if (result.length === limit) return result;
        }
        if (page.length < HUB_LIMITS.searchPageMax) return result;
      }
    }, signal);
  }
  async respond(context: HubServerContext, invitationId: string, decision: 'accept' | 'decline', signal?: AbortSignal) {
    const app = this.app;
    z.enum(['accept', 'decline']).parse(decision);
    return app.change(context, 'register', invitationId, { operation: 'profile.invitation.respond', decision }, async tx => {
      const data = app.data(tx), invitation = hubInvitationSchema.parse(data.get('invitations', invitationId));
      if (invitation.accountId !== context.principal.id) throw new HubServerError('HUB_SERVER_DENIED');
      if (invitation.state !== 'pending') throw new HubServerError('HUB_PROFILE_REFUSED');
      app.limit(tx, context.principal.id, 'profile-membership', app.service.policy.maxChallenges, app.service.policy.challengeTtlMs);
      const now = app.ports.now(), state = invitation.expiresAtMs <= now ? 'expired' : decision === 'accept' ? 'accepted' : 'declined';
      let profile: HubProfile | null = null;
      if (state === 'accepted') {
        const current = app.profile(tx, invitation.profileId), consent = app.membershipConsent(tx, current);
        const inviter = data.get('accounts', invitation.inviterId) as { status?: unknown } | null;
        if (current.status !== 'active' || inviter?.status !== 'active' || !app.consented(tx, current, invitation.inviterId)
          || !current.members.some(m => m.accountId === invitation.inviterId && m.role === 'owner') || app.consented(tx, current, invitation.accountId)
          || current.members.length >= app.service.policy.maxMembers) throw new HubServerError('HUB_PROFILE_REFUSED');
        // Never drop anyone here: removal (with key revocation) belongs to members() alone.
        const members = [...current.members, { accountId: invitation.accountId, role: invitation.role }];
        data.put('membership-consents', current.id, { ...consent, members: [...consent.members, { accountId: invitation.accountId, acceptedAtMs: now }] });
        profile = await app.saveProfile(tx, { ...current, members, sequence: current.sequence + 1 });
      }
      const resolved = { ...invitation, state, resolvedAtMs: now };
      data.put('invitations', invitation.id, resolved);
      const action = { accepted: 'profile-invitation-accepted', declined: 'profile-invitation-declined', expired: 'profile-invitation-expired' }[state];
      await app.log(tx, context.principal.id, action, invitation.id); return { invitation: resolved, profile };
    }, signal);
  }
  async keyChallenge(context: HubServerContext, profileId: string, input: unknown, signal?: AbortSignal) {
    const app = this.app, key = hubRegisteredKeySchema.parse(input);
    return app.change(context, 'register', profileId, { key }, async tx => {
      const profile = app.profile(tx, profileId); this.owner(tx, profile, context);
      if (key.role !== 'publisher' || key.publisherId !== `@${profile.handle}` || !key.active || key.trustedAiReviewer
        || ed25519KeyId(Buffer.from(key.publicKey, 'base64')) !== key.keyId
        || key.principal.kind === 'person' && !app.consented(tx, profile, key.principal.id)) throw new HubServerError('HUB_PROFILE_REFUSED');
      app.limit(tx, context.principal.id, 'key-challenge', app.service.policy.maxChallenges, app.service.policy.challengeTtlMs);
      const challenge = { id: app.opaque(), accountId: context.principal.id, purpose: 'key' as const,
        binding: canonicalHubJson({ profileId, key }), expiresAtMs: app.ports.now() + app.service.policy.challengeTtlMs };
      app.data(tx).put('challenges', challenge.id, challenge); return challenge;
    }, signal);
  }
  async addKey(context: HubServerContext, profileId: string, challengeId: string, signature: string, signal?: AbortSignal) {
    const app = this.app;
    return app.change(context, 'register', profileId, { challengeId, signature }, async tx => {
      const data = app.data(tx), profile = app.profile(tx, profileId); this.owner(tx, profile, context);
      const challenge = hubChallengeSchema.parse(data.get('challenges', challengeId));
      if (challenge.purpose !== 'key' || challenge.accountId !== context.principal.id || challenge.expiresAtMs <= app.ports.now()) throw new HubServerError('HUB_PROFILE_REFUSED');
      const binding = z.object({ profileId: identitySchema, key: hubRegisteredKeySchema }).strict().parse(JSON.parse(challenge.binding));
      const key = binding.key;
      if (binding.profileId !== profileId || profile.keys.length >= app.service.policy.maxKeys || await tx.key(key.keyId, 'publisher')
        || key.principal.kind === 'person' && !app.consented(tx, profile, key.principal.id)) throw new HubServerError('HUB_PROFILE_REFUSED');
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
      const profile = app.profile(tx, profileId); this.owner(tx, profile, context);
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
      this.owner(tx, app.profile(tx, profileId), context);
      const challenge = { id: app.opaque(), accountId: context.principal.id, purpose: 'domain' as const,
        binding: canonicalHubJson({ profileId, domain }), expiresAtMs: app.ports.now() + app.service.policy.challengeTtlMs };
      app.data(tx).put('challenges', challenge.id, challenge); return { challengeId: challenge.id, txt: `deckent-hub-verify=${challenge.id}` };
    }, signal);
  }
  async verifyDomain(context: HubServerContext, profileId: string, challengeId: string, signal?: AbortSignal) {
    const app = this.app;
    return app.change(context, 'register', profileId, { challengeId }, async tx => {
      const profile = app.profile(tx, profileId); this.owner(tx, profile, context);
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
