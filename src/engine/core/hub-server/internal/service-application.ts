import { z } from 'zod';
import { canonicalHubJson, HUB_LIMITS, hubPackageSignatureSchema, type HubEnvelope, type HubPackage } from '#domain/index.js';
import { sha256 } from '#platform/index.js';
import type { HubPackageFile } from '#engine/core/hub/index.js';
import { HubServerError, type HubServerContext, type HubServerPorts, type HubServerTransaction, type HubStoredVersion } from './ports.js';
import { hubAccountSchema, hubQueueSchema, hubRosterSchema, hubReportSchema, hubCaseSchema, type HubProfile, type HubQueue, type HubServiceDependencies } from './service-contract.js';
import { HubServiceBase } from './service-base.js';
import { newerHubVersion } from './dependencies.js';
import { HubAccounts } from './accounts.js';
import { HubProfiles } from './profiles.js';
import { approveHubVersion, HubModeration, requireModerator } from './moderation.js';

export const hubQueueId = (packageId: string, version: string) => sha256(canonicalHubJson({ packageId, version }));
/** The moderated service is the H3 application with additional gates under the same writer, not a parallel publish path. */
export class HubModeratedApplication extends HubServiceBase {
  readonly accounts = new HubAccounts(this);
  readonly profiles = new HubProfiles(this);
  readonly moderation = new HubModeration(this, (tx, entries) => this.recordRevocations(tx, entries));
  constructor(ports: HubServerPorts, service: HubServiceDependencies) { super(ports, service); }
  async publicLimit(addressId: string, search: boolean) {
    return this.ports.store.transaction(async tx => this.limit(tx, addressId, search ? 'public-search' : 'public-read',
      search ? this.service.policy.searchesPerAddress : this.service.policy.readsPerAddress, this.service.policy.readWindowMs));
  }
  async publicLog(context: HubServerContext, after = 0, limit = HUB_LIMITS.searchPageMax) {
    await this.authorize(context, 'read', 'moderation-log', '');
    return this.ports.store.transaction(async tx => this.data(tx).publicAuditPage(after, limit));
  }
  async moderatorRoster(context: HubServerContext) {
    await this.authorize(context, 'read', 'roster', '');
    return this.ports.store.transaction(async tx => hubRosterSchema.parse(this.data(tx).get('roster', this.ports.hubId)));
  }
  async publicProfile(context: HubServerContext, handle: string) {
    await this.authorize(context, 'read', 'profile', '');
    return this.ports.store.transaction(async tx => {
      for (const row of this.rows(this.data(tx), 'profiles')) {
        const profile = this.profile(tx, row.id);
        if (profile.handle === handle && profile.status === 'active') return profile;
      }
      throw new HubServerError('HUB_RESOURCE_UNKNOWN');
    });
  }
  override async register(_context: HubServerContext, _input: unknown): Promise<never> {
    void _context; void _input;
    // Service keys join by profile challenge or root roster; H3's operator registration cannot bypass these gates.
    throw new HubServerError('HUB_SERVER_DENIED');
  }
  protected override async publicationGate(store: Pick<HubServerTransaction, 'key' | 'revocations'>, context: HubServerContext, manifest: HubPackage,
    envelope: HubEnvelope, _files: readonly HubPackageFile[], now: number): Promise<void> {
    const check = async (tx: HubServerTransaction) => {
      const data = this.data(tx), keyId = envelope.signatures.find(s => s.role === 'publisher')!.keyId;
      let found = false;
      for (const row of this.rows(data, 'profiles')) {
        const profile = this.profile(tx, row.id);
        if (manifest.packageId.split('/')[0] !== `@${profile.handle}`) continue;
        const key = profile.keys.find(k => k.keyId === keyId && k.state === 'active' && k.principalId === context.principal.id && k.principalKind === context.principal.kind);
        if (profile.status !== 'active' || !key) throw new HubServerError('HUB_PROFILE_REFUSED');
        if (context.principal.kind === 'person') this.account(tx, context);
        const accountable = key.memberAccountId ? [key.memberAccountId] : profile.members.filter(m => m.role === 'owner').map(m => m.accountId);
        if (!accountable.length || !accountable.some(id => {
          const account = hubAccountSchema.parse(data.get('accounts', id));
          return account.status === 'active' && now - account.createdAtMs >= this.service.policy.minAccountAgeMs;
        })) throw new HubServerError('HUB_ACCOUNT_REFUSED');
        found = true;
      }
      if (!found) throw new HubServerError('HUB_PROFILE_REFUSED');
      for (const dependency of manifest.dependencies) {
        const target = await tx.get(dependency.packageId, dependency.version);
        if (!target || !await this.readable(tx, target, true)) throw new HubServerError('HUB_DEPENDENCY_INVALID');
      }
    };
    if ('service' in store) await check(store as HubServerTransaction);
    else await this.ports.store.transaction(check);
  }
  protected override async publicationRecorded(tx: HubServerTransaction, row: HubStoredVersion, context: HubServerContext, now: number) {
    const data = this.data(tx), policy = this.service.policy;
    let profile: HubProfile | undefined;
    for (const item of this.rows(data, 'profiles')) {
      const candidate = this.profile(tx, item.id); if (row.manifest.packageId.startsWith(`@${candidate.handle}/`)) { profile = candidate; break; }
    }
    if (!profile) throw new HubServerError('HUB_PROFILE_REFUSED');
    let approvedBefore = false, existingPackage = false, prior: HubQueue | undefined, typosquat = false;
    const skeleton = (text: string) => [...text].map(c => policy.confusables[c] ?? c).join('');
    for (const item of this.rows(data, 'queue')) {
      const queue = hubQueueSchema.parse(item.value);
      if (queue.profileId === profile.id) {
        approvedBefore ||= queue.state === 'approved';
        if (queue.packageId === row.manifest.packageId) { existingPackage = true; if (!prior || newerHubVersion(queue.version, prior.version)) prior = queue; }
      }
      typosquat ||= queue.packageId !== row.manifest.packageId && skeleton(queue.packageId.split('/')[1]!) === skeleton(row.manifest.packageId.split('/')[1]!);
    }
    this.limit(tx, profile.id, 'publish', policy.publishesPerProfile, policy.publishWindowMs);
    this.limit(tx, row.manifest.packageId, 'version', policy.versionsPerPackage, policy.dayWindowMs);
    if (!existingPackage) this.limit(tx, profile.id, 'new-package', policy.newPackagesPerProfile, policy.dayWindowMs);
    const first = !approvedBefore || profile.recoveryReview;
    const supporting = row.manifest.items.some(item => item.kind === 'skill' && item.files.length > 1);
    const risky = row.manifest.items.some(item => item.kind === 'agent' && item.workClassHints.some(h => policy.highRiskWorkClasses.includes(h)));
    const ai = context.principal.kind !== 'person', signals: string[] = [];
    for (const file of row.files) {
      const text = Buffer.from(await this.ports.artifacts.read(this.ports.scopeId, file.artifact)).toString('utf8');
      if (/ignore\s+(?:all\s+)?previous\s+instructions|system\s+prompt|disable\s+safety/i.test(text)) signals.push('prompt-injection');
      if (/^#!|<script\b|(?:eval|exec|spawn)\s*\(/m.test(text)) signals.push('script-like');
    }
    // Confusable handles are denied at profile creation; package-name similarity remains a review signal.
    if (typosquat) signals.push('typosquat');
    const queue = hubQueueSchema.parse({ schemaVersion: 1, id: hubQueueId(row.manifest.packageId, row.manifest.version), profileId: profile.id,
      packageId: row.manifest.packageId, version: row.manifest.version, digest: row.envelope.payloadDigest, state: 'pending-review',
      required: first || supporting || risky || ai || signals.includes('script-like') ? 2 : 1, hidden: false,
      signals: [...new Set(signals)], previousDigest: prior?.digest ?? null, approvals: [], receivedAtMs: now });
    data.put('queue', queue.id, { ...queue, state: 'received' }); await this.log(tx, context.principal.id, 'received', queue.id);
    data.put('queue', queue.id, { ...queue, state: 'scanned' }); await this.log(tx, context.principal.id, 'scanned', queue.id);
    data.put('queue', queue.id, queue); await this.log(tx, context.principal.id, 'pending-review', queue.id);
  }
  override async review(context: HubServerContext, packageId: string, version: string, input: unknown, signal?: AbortSignal) {
    const signature = hubPackageSignatureSchema.parse(input);
    return this.change(context, 'review', packageId, { version, signature }, async tx => {
      const queue = hubQueueSchema.parse(this.data(tx).get('queue', hubQueueId(packageId, version)));
      const result = await approveHubVersion(this, tx, context, queue, signature);
      // Preserve H3's return contract, with a signed receipt in the same transaction.
      const { signer } = await this.signer(this.clock());
      const receipt = await tx.appendReceipt({ action: 'review', context, resource: queue.id, digest: sha256(canonicalHubJson(result.envelope)), atMs: this.clock() }, signer);
      return { ...result, receipt };
    }, signal);
  }
  private async readable(tx: HubServerTransaction, row: HubStoredVersion, listing: boolean) {
    const queue = hubQueueSchema.parse(this.data(tx).get('queue', hubQueueId(row.manifest.packageId, row.manifest.version)));
    const profile = this.profile(tx, queue.profileId), publisherId = row.envelope.signatures.find(s => s.role === 'publisher')!.keyId;
    const binding = profile.keys.find(key => key.keyId === publisherId && key.state === 'active');
    if (queue.state !== 'approved' || profile.status !== 'active' || !binding || listing && queue.hidden) return false;
    if (binding.memberAccountId && hubAccountSchema.parse(this.data(tx).get('accounts', binding.memberAccountId)).status !== 'active') return false;
    const revoked = await tx.revocations([{ kind: 'package-version', id: `${queue.packageId}@${queue.version}` },
      { kind: 'publisher', id: `@${profile.handle}` }, ...row.envelope.signatures.map(s => ({ kind: 'key' as const, id: s.keyId }))]);
    return revoked.length === 0;
  }
  override async inspect(context: HubServerContext, packageId: string, version: string) {
    await this.authorize(context, 'read', packageId, '');
    return this.ports.store.transaction(async tx => {
      const row = await this.requireVersion(packageId, version, tx);
      if (!await this.readable(tx, row, false)) throw new HubServerError('HUB_RESOURCE_UNKNOWN');
      await this.authorize(context, 'read', packageId, ''); return row;
    });
  }
  override async readFile(context: HubServerContext, packageId: string, version: string, path: string) {
    const bytes = await super.readFile(context, packageId, version, path);
    await this.inspect(context, packageId, version); return bytes;
  }
  override async search(context: HubServerContext, after = '', limit = HUB_LIMITS.searchPageMax) {
    await this.authorize(context, 'read', 'packages', '');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > HUB_LIMITS.searchPageMax || after.length > HUB_LIMITS.packageMaxBytes) throw new HubServerError('HUB_RATE_REFUSED');
    return this.ports.store.transaction(async tx => {
      const result: { key: string; manifest: HubPackage; envelope: HubEnvelope; revocationState: 'clear' }[] = [];
      let cursor = after;
      while (result.length < limit) {
        const refs = await tx.packages(cursor, HUB_LIMITS.searchPageMax);
        for (const ref of refs) {
          const row = await this.requireVersion(ref.packageId, ref.version, tx);
          if (await this.readable(tx, row, true)) result.push({ key: ref.key, manifest: row.manifest, envelope: row.envelope, revocationState: 'clear' });
          cursor = ref.key; if (result.length === limit) break;
        }
        if (refs.length < HUB_LIMITS.searchPageMax) break;
      }
      await this.authorize(context, 'read', 'packages', ''); return result;
    });
  }
  override async listSkills(context: HubServerContext, after = '', limit = HUB_LIMITS.searchPageMax) {
    await this.authorize(context, 'read', 'skills', '');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > HUB_LIMITS.searchPageMax || after.length > HUB_LIMITS.packageMaxBytes) throw new HubServerError('HUB_RATE_REFUSED');
    return this.ports.store.transaction(async tx => {
      const result: Awaited<ReturnType<HubServerTransaction['skills']>>[number][] = []; let cursor = after;
      while (result.length < limit) {
        const refs = await tx.skills(cursor, HUB_LIMITS.searchPageMax);
        for (const ref of refs) {
          if (await this.readable(tx, await this.requireVersion(ref.packageId, ref.version, tx), true)) result.push(ref);
          cursor = ref.key; if (result.length === limit) break;
        }
        if (refs.length < HUB_LIMITS.searchPageMax) break;
      }
      await this.authorize(context, 'read', 'skills', ''); return result;
    });
  }
  async evidence(context: HubServerContext, packageId: string, version: string) {
    await this.inspect(context, packageId, version);
    return this.ports.store.transaction(async tx => {
      const queue = hubQueueSchema.parse(this.data(tx).get('queue', hubQueueId(packageId, version)));
      return { profile: this.profile(tx, queue.profileId), roster: hubRosterSchema.parse(this.data(tx).get('roster', this.ports.hubId)) };
    });
  }
  async reviewBundle(context: HubServerContext, packageId: string, version: string, keyId: string, signal?: AbortSignal) {
    return this.change(context, 'review', packageId, { version, keyId }, async tx => {
      await requireModerator(this, tx, context, keyId, this.clock());
      const row = await this.requireVersion(packageId, version, tx);
      const files = await Promise.all(row.files.map(async file => {
        const bytes = await this.ports.artifacts.read(this.ports.scopeId, file.artifact);
        if (sha256(bytes) !== file.artifact.digest || bytes.byteLength !== file.artifact.byteLength) throw new HubServerError('HUB_STORE_UNSAFE');
        return { path: file.path, bytes: Buffer.from(bytes).toString('base64') };
      }));
      const queue = hubQueueSchema.parse(this.data(tx).get('queue', hubQueueId(packageId, version)));
      let previousManifest: HubPackage | null = null;
      if (queue.previousDigest) for (const item of this.rows(this.data(tx), 'queue')) {
        const previous = hubQueueSchema.parse(item.value);
        if (previous.packageId === packageId && previous.digest === queue.previousDigest) previousManifest = (await tx.get(previous.packageId, previous.version))?.manifest ?? null;
      }
      const oldFiles = previousManifest ? (await tx.get(previousManifest.packageId, previousManifest.version))!.files : [];
      const changes = [...row.files.filter(file => !oldFiles.some(old => old.path === file.path && old.artifact.digest === file.artifact.digest))
        .map(file => ({ path: file.path, change: oldFiles.some(old => old.path === file.path) ? 'changed' : 'added' })),
        ...oldFiles.filter(file => !row.files.some(current => current.path === file.path)).map(file => ({ path: file.path, change: 'removed' }))];
      return { ...row, files, previousManifest, changes };
    }, signal);
  }
  override async withdraw(_context: HubServerContext, _severity: 'yank' | 'revoke', _input: unknown, _signal?: AbortSignal): Promise<never> {
    void _context; void _severity; void _input; void _signal;
    throw new HubServerError('HUB_REVIEW_REFUSED');
  }
  async report(context: HubServerContext, input: unknown, signal?: AbortSignal) {
    const command = z.object({ targetId: z.string(), reason: z.string(), appealOf: z.string().nullable() }).strict().parse(input);
    return this.change(context, 'review', command.targetId, command, async tx => {
      if (!Object.hasOwn(this.service.policy.reasons, command.reason)) throw new HubServerError('HUB_REVIEW_REFUSED');
      const data = this.data(tx), queue = data.get('queue', command.targetId);
      if (!queue && !data.get('profiles', command.targetId) && !data.get('accounts', command.targetId)) throw new HubServerError('HUB_RESOURCE_UNKNOWN');
      if (command.appealOf) {
        const original = hubCaseSchema.parse(data.get('cases', command.appealOf));
        const profile = queue ? this.profile(tx, hubQueueSchema.parse(queue).profileId) : data.get('profiles', command.targetId) ? this.profile(tx, command.targetId) : null;
        if (original.command.targetId !== command.targetId || (original.command.targetKind === 'account' ? command.targetId !== context.principal.id
          : !profile?.members.some(m => m.accountId === context.principal.id))) throw new HubServerError('HUB_REVIEW_REFUSED');
      }
      this.limit(tx, context.principal.id, 'report', this.service.policy.reportsPerAccount, this.service.policy.dayWindowMs);
      const report = hubReportSchema.parse({ id: this.opaque(), accountId: context.principal.id, ...command, severity: this.service.policy.reasons[command.reason],
        assignedTo: null, resolved: false, createdAtMs: this.clock() });
      data.put('reports', report.id, report); await this.log(tx, context.principal.id, command.appealOf ? 'appeal' : 'report', report.id, command.reason); return report;
    }, signal, command.appealOf !== null);
  }
  async reports(context: HubServerContext, keyId: string, limit = HUB_LIMITS.searchPageMax, signal?: AbortSignal) {
    return this.change(context, 'review', 'reports', { keyId, limit }, async tx => {
      await requireModerator(this, tx, context, keyId, this.clock());
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > HUB_LIMITS.searchPageMax) throw new HubServerError('HUB_RATE_REFUSED');
      const result: z.infer<typeof hubReportSchema>[] = [];
      for (const row of this.rows(this.data(tx), 'reports')) {
        const report = hubReportSchema.parse(row.value); if (report.resolved) continue;
        result.push(report); result.sort((a, b) => b.severity - a.severity || a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id));
        if (result.length > limit) result.pop();
      }
      return result;
    }, signal);
  }
}
