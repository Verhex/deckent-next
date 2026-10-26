import { canonicalHubJson, HUB_LIMITS, type HubPackageSignature, type HubRevocationFeed } from '#domain/index.js';
import { signatureMessage } from '#platform/index.js';
import { hubPackageSignatureMessage, requireHubSignature } from '#engine/core/hub/index.js';
import { HubServerError, type HubServerContext, type HubServerTransaction } from './ports.js';
import { hubCaseSchema, hubModerationCommandSchema, hubQueueSchema, hubRosterSchema, hubRecoverySchema, hubAccountSchema, hubReportSchema,
  type HubModerationCommand, type HubQueue } from './service-contract.js';
import type { HubServiceBase } from './service-base.js';

export const hubModerationMessage = (hubId: string, input: unknown) => {
  const { signature: _signature, ...payload } = hubModerationCommandSchema.parse(input);
  void _signature;
  return signatureMessage('hub-moderation-action:1', canonicalHubJson({ hubId, ...payload }));
};
export async function requireModerator(app: HubServiceBase, tx: HubServerTransaction, context: HubServerContext, keyId: string, signedAtMs: number) {
  const account = app.account(tx, context), roster = hubRosterSchema.parse(app.data(tx).get('roster', app.ports.hubId));
  const entry = roster.entries.find(e => e.accountRef === account.id && e.keyId === keyId), now = app.ports.now();
  if (!entry || signedAtMs > now || signedAtMs < entry.notBefore || signedAtMs >= entry.notAfter || now >= entry.notAfter || now < entry.notBefore) throw new HubServerError('HUB_REVIEW_REFUSED');
  const key = await tx.key(keyId, 'reviewer');
  if (!key?.active || key.publicKey !== entry.publicKey || (await tx.revocations([{ kind: 'key', id: keyId }])).some(e => e.severity === 'revoke')) throw new HubServerError('HUB_REVIEW_REFUSED');
  return { entry, key };
}
export async function approveHubVersion(app: HubServiceBase, tx: HubServerTransaction, context: HubServerContext, queue: HubQueue, signature: HubPackageSignature) {
  const { key } = await requireModerator(app, tx, context, signature.keyId, signature.signedAtMs), profile = app.profile(tx, queue.profileId);
  if (queue.state !== 'pending-review' || profile.status !== 'active' || profile.members.some(m => m.accountId === context.principal.id)
    || queue.approvals.some(a => a.accountId === context.principal.id || a.signature.keyId === key.keyId)
    || signature.role !== 'reviewer' || signature.reviewLevel !== 'moderated') throw new HubServerError('HUB_REVIEW_REFUSED');
  const row = await tx.get(queue.packageId, queue.version);
  if (!row || row.envelope.payloadDigest !== queue.digest) throw new HubServerError('HUB_STORE_CONFLICT');
  const roster = hubRosterSchema.parse(app.data(tx).get('roster', app.ports.hubId));
  for (const approval of queue.approvals) {
    const entry = roster.entries.find(e => e.keyId === approval.signature.keyId && e.accountRef === approval.accountId), oldKey = await tx.key(approval.signature.keyId, 'reviewer');
    if (!entry || !oldKey?.active || oldKey.publicKey !== entry.publicKey || approval.signature.signedAtMs < entry.notBefore || approval.signature.signedAtMs >= entry.notAfter
      || profile.members.some(m => m.accountId === approval.accountId) || hubAccountSchema.parse(app.data(tx).get('accounts', approval.accountId)).status !== 'active'
      || (await tx.revocations([{ kind: 'key', id: entry.keyId }])).some(e => e.severity === 'revoke')) throw new HubServerError('HUB_REVIEW_REFUSED');
    requireHubSignature(oldKey, oldKey.keyId, hubPackageSignatureMessage(row.manifest, row.envelope, approval.signature), approval.signature.value);
  }
  requireHubSignature(key, key.keyId, hubPackageSignatureMessage(row.manifest, row.envelope, signature), signature.value);
  const approvals = [...queue.approvals, { accountId: context.principal.id, signature }], approved = approvals.length >= queue.required;
  let envelope = { ...row.envelope, signatures: [...row.envelope.signatures.filter(s => s.role !== 'reviewer'), ...approvals.map(a => a.signature)] };
  if (approved) {
    const now = app.ports.now(), { signer } = await app.attestation(now), payload = { role: 'hub' as const, signedAtMs: now,
      reviewLevel: 'moderated', moderatorKeyIds: approvals.map(a => a.signature.keyId) };
    envelope = { ...envelope, signatures: [...envelope.signatures.filter(s => s.role !== 'hub'), { ...payload, keyId: signer.keyId,
      algorithm: 'ed25519', value: Buffer.from(await signer.sign(hubPackageSignatureMessage(row.manifest, envelope, payload))).toString('base64') }] };
  }
  await tx.replaceEnvelope(queue.packageId, queue.version, row.revision, envelope);
  app.data(tx).put('queue', queue.id, { ...queue, approvals, state: approved ? 'approved' : 'pending-review' });
  if (approved && profile.recoveryReview) await app.saveProfile(tx, { ...profile, sequence: profile.sequence + 1, recoveryReview: false });
  await app.log(tx, context.principal.id, approved ? 'approve' : 'review-vote', queue.id, null, approved);
  return { envelope, approved, remaining: Math.max(0, queue.required - approvals.length) };
}
export class HubModeration {
  constructor(private readonly app: HubServiceBase,
    private readonly feed: (tx: HubServerTransaction, entries: HubRevocationFeed['entries']) => Promise<HubRevocationFeed>) {}
  async queue(context: HubServerContext, after = '', limit = HUB_LIMITS.searchPageMax, signal?: AbortSignal) {
    const app = this.app;
    return app.change(context, 'review', 'queue', { after, limit }, async tx => {
      const roster = hubRosterSchema.parse(app.data(tx).get('roster', app.ports.hubId));
      if (!roster.entries.some(e => e.accountRef === context.principal.id && e.notBefore <= app.ports.now() && app.ports.now() < e.notAfter)) throw new HubServerError('HUB_REVIEW_REFUSED');
      return app.data(tx).list('queue', after, limit).map(row => hubQueueSchema.parse(row.value));
    }, signal);
  }
  async act(context: HubServerContext, input: unknown, signal?: AbortSignal) {
    const app = this.app, command = hubModerationCommandSchema.parse(input);
    return app.change(context, 'review', command.targetId, command, async tx => {
      const { entry, key } = await requireModerator(app, tx, context, command.keyId, command.signedAtMs);
      requireHubSignature(key, key.keyId, hubModerationMessage(app.ports.hubId, command), command.signature);
      if (!Object.hasOwn(app.service.policy.reasons, command.reason)) throw new HubServerError('HUB_REVIEW_REFUSED');
      const data = app.data(tx), storedCase = data.get('cases', command.commandId), previous = storedCase ? hubCaseSchema.parse(storedCase) : null;
      const identity = (c: HubModerationCommand) => canonicalHubJson({ action: c.action, targetKind: c.targetKind, targetId: c.targetId, reason: c.reason, emergency: c.emergency, appealId: c.appealId ?? null, recoveryId: c.recoveryId ?? null });
      if (previous && identity(previous.command) !== identity(command)) throw new HubServerError('HUB_STORE_CONFLICT');
      if (previous?.accounts.includes(context.principal.id)) {
        if (previous.votes.some(vote => canonicalHubJson(vote) === canonicalHubJson(command))) return previous;
        throw new HubServerError('HUB_REVIEW_REFUSED');
      }
      const profile = command.targetKind === 'profile' ? app.profile(tx, command.targetId) : command.targetKind === 'version'
        ? app.profile(tx, hubQueueSchema.parse(data.get('queue', command.targetId)).profileId) : null;
      if (command.targetKind === 'account' && command.targetId === context.principal.id || profile?.members.some(m => m.accountId === context.principal.id)) throw new HubServerError('HUB_REVIEW_REFUSED');
      if (command.appealId) {
        const appeal = hubReportSchema.parse(data.get('reports', command.appealId)), original = appeal.appealOf ? hubCaseSchema.parse(data.get('cases', appeal.appealOf)) : null;
        if (!original || appeal.resolved || appeal.targetId !== command.targetId || original.accounts.includes(context.principal.id)) throw new HubServerError('HUB_REVIEW_REFUSED');
      }
      let approvalApplied = false;
      if (previous?.applied && previous.confirmByMs === null) throw new HubServerError('HUB_REVIEW_REFUSED');
      if (command.action === 'approve') {
        if (command.targetKind !== 'version' || !command.review || command.review.keyId !== command.keyId) throw new HubServerError('HUB_REVIEW_REFUSED');
        approvalApplied = (await approveHubVersion(app, tx, context, hubQueueSchema.parse(data.get('queue', command.targetId)), command.review)).approved;
      }
      const two = ['revoke', 'ban'].includes(command.action), accounts = [...previous?.accounts ?? [], context.principal.id], keyIds = [...previous?.keyIds ?? [], key.keyId];
      if (new Set(keyIds).size !== keyIds.length || previous?.applied && previous.confirmByMs === null) throw new HubServerError('HUB_REVIEW_REFUSED');
      const emergency = command.emergency && command.action === 'revoke' && entry.role === 'senior-moderator';
      if (command.emergency && !emergency && !previous?.applied) throw new HubServerError('HUB_REVIEW_REFUSED');
      const applied = command.action === 'approve' ? approvalApplied : !two || accounts.length >= 2 || emergency;
      const record = { id: command.commandId, command: hubModerationCommandSchema.parse(previous?.command ?? command), accounts, keyIds, votes: [...previous?.votes ?? [], command], applied,
        confirmByMs: applied && two && accounts.length < 2 ? app.ports.now() + app.service.policy.emergencyConfirmMs : null, escalated: previous?.escalated ?? false };
      if (applied && !previous?.applied && command.action !== 'approve') await this.apply(tx, context, command);
      data.put('cases', record.id, record);
      if (applied && command.appealId) {
        const appeal = hubReportSchema.parse(data.get('reports', command.appealId)); data.put('reports', appeal.id, { ...appeal, resolved: true, assignedTo: context.principal.id });
      }
      await app.log(tx, context.principal.id, applied ? command.action : 'moderation-vote', command.targetId, command.reason,
        applied && ['reject', 'ban'].includes(command.action));
      return record;
    }, signal);
  }
  private async apply(tx: HubServerTransaction, context: HubServerContext, command: HubModerationCommand) {
    const app = this.app, data = app.data(tx), entries: HubRevocationFeed['entries'][number][] = [], now = app.ports.now();
    if (command.action === 'recover-key') {
      if (command.targetKind !== 'profile' || !command.recoveryId) throw new HubServerError('HUB_REVIEW_REFUSED');
      const profile = app.profile(tx, command.targetId), recovery = hubRecoverySchema.parse(data.get('recoveries', command.recoveryId));
      const lost = profile.keys.find(key => key.keyId === recovery.lostKeyId && key.state === 'active');
      if (profile.keys.length >= app.service.policy.maxKeys || recovery.approved || recovery.profileId !== profile.id || !lost || await tx.key(recovery.key.keyId, 'publisher')
        || !profile.members.some(m => m.accountId === recovery.accountId && m.role === 'owner')) throw new HubServerError('HUB_REVIEW_REFUSED');
      const registered = await tx.key(lost.keyId, 'publisher'); if (!registered) throw new HubServerError('HUB_PROFILE_REFUSED');
      await tx.putKey({ ...registered, active: false }); await tx.putKey(recovery.key);
      await app.saveProfile(tx, { ...profile, sequence: profile.sequence + 1, recoveryReview: true,
        keys: [...profile.keys.map(k => k.keyId === lost.keyId ? { ...k, state: 'revoked' as const } : k), {
          keyId: recovery.key.keyId, publicKey: recovery.key.publicKey, principalId: recovery.key.principal.id, principalKind: recovery.key.principal.kind,
          memberAccountId: recovery.key.principal.kind === 'person' ? recovery.key.principal.id : null, addedAtMs: now, state: 'active' }] });
      data.put('recoveries', recovery.id, { ...recovery, approved: true });
      await this.feed(tx, [{ kind: 'key', id: lost.keyId, reason: command.reason, severity: 'revoke', atMs: now }]);
      return;
    }
    if (command.targetKind === 'version') {
      const queue = hubQueueSchema.parse(data.get('queue', command.targetId));
      if (['reject', 'request-changes'].includes(command.action)) {
        if (queue.state !== 'pending-review') throw new HubServerError('HUB_REVIEW_REFUSED');
        data.put('queue', queue.id, { ...queue, state: command.action === 'reject' ? 'rejected' : 'changes-requested' });
      } else if (['hide', 'restore'].includes(command.action)) {
        if (command.action === 'restore' && ['rejected', 'changes-requested'].includes(queue.state)) data.put('queue', queue.id, { ...queue, state: 'pending-review', approvals: [], hidden: false });
        else {
          if (queue.state !== 'approved') throw new HubServerError('HUB_REVIEW_REFUSED');
          data.put('queue', queue.id, { ...queue, hidden: command.action === 'hide' });
        }
      } else if (['yank', 'revoke'].includes(command.action)) entries.push({ kind: 'package-version', id: `${queue.packageId}@${queue.version}`,
        reason: command.reason, severity: command.action as 'yank' | 'revoke', atMs: now });
      else throw new HubServerError('HUB_REVIEW_REFUSED');
    } else {
      if (!['suspend', 'ban', 'unban', 'restore'].includes(command.action)) throw new HubServerError('HUB_REVIEW_REFUSED');
      const status = command.action === 'ban' ? 'banned' : command.action === 'suspend' ? 'suspended' : 'active';
      if (command.targetKind === 'profile') {
        const profile = app.profile(tx, command.targetId);
        await app.saveProfile(tx, { ...profile, sequence: profile.sequence + 1, status });
        if (status === 'banned') entries.push({ kind: 'publisher', id: `@${profile.handle}`, reason: command.reason, severity: app.service.policy.maliciousReasons.includes(command.reason) ? 'revoke' : 'yank', atMs: now });
      } else {
        const account = hubAccountSchema.parse(data.get('accounts', command.targetId));
        data.put('accounts', account.id, { ...account, status });
        if (status === 'banned') for (const row of app.rows(data, 'profiles')) {
          const profile = app.profile(tx, row.id), owns = profile.members.some(m => m.accountId === account.id && m.role === 'owner');
          for (const key of profile.keys) if (key.principalId === account.id || owns && key.principalKind !== 'person')
            entries.push({ kind: 'key', id: key.keyId, reason: command.reason, severity: app.service.policy.maliciousReasons.includes(command.reason) ? 'revoke' : 'yank', atMs: now });
        }
      }
    }
    // Feed bounds are observed per signed delta; every delta and state change commits together.
    for (let start = 0; start < entries.length; start += HUB_LIMITS.feedPageMax) await this.feed(tx, entries.slice(start, start + HUB_LIMITS.feedPageMax));
    await app.log(tx, context.principal.id, 'moderation-apply', command.targetId, command.reason);
  }
  async escalate(context: HubServerContext, signal?: AbortSignal) {
    const app = this.app;
    return app.change(context, 'operate', 'emergency', { operation: 'moderation.escalate' }, async tx => {
      app.admin(tx, context); const data = app.data(tx), ids: string[] = [];
      for (const row of app.rows(data, 'cases')) {
        const item = hubCaseSchema.parse(row.value);
        if (item.confirmByMs !== null && item.confirmByMs <= app.ports.now() && !item.escalated) {
          data.put('cases', item.id, { ...item, escalated: true }); ids.push(item.id); await app.log(tx, context.principal.id, 'emergency-escalate', item.id);
        }
      }
      return ids;
    }, signal);
  }
}
