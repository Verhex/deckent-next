import { identityDistributionSubmissionSchema, IdentityProfileError } from '#domain/index.js';
import { IdentityProfileDistributionApplication, type IdentityDistributionSource } from '#engine/index.js';
import { attestLocalInteractiveTerminal, localPrincipalPeer, openSqliteInventoryReader } from '#adapters/index.js';
import { ErrorRegistry, inspectProductFile, sha256, t, type ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { withPolicyAdministration } from '#composition/core/approvals/index.js';
import { identityProfileContext, identityFailure } from './configured.js';
async function context(root: string, options: ConfigLoadOptions) { const ctx = await identityProfileContext(root, [], options), source: IdentityDistributionSource = { async load(scopes) {
    const snapshot = await ctx.source.load(scopes), { issuer, subject, id } = snapshot.principal; return { ...snapshot, principals: [{ id: `os-${sha256(`${issuer}\0${subject}`).slice(0, 24)}`, label: id, kind: 'human', principal: { issuer, subject } }] };
  } }; return { ...ctx, source }; }
export async function listConfiguredIdentityDistributionChoices(root: string, scopeId: string, options: ConfigLoadOptions = {}) { try { const ctx = await context(root, options); return await new IdentityProfileDistributionApplication(ctx.registry, ctx.source).choices(scopeId); } catch (error) { return identityFailure(error); } }
export async function previewConfiguredIdentityDistribution(root: string, selection: unknown, options: ConfigLoadOptions = {}) { try { const ctx = await context(root, options); return await new IdentityProfileDistributionApplication(ctx.registry, ctx.source).preview(selection); } catch (error) { return identityFailure(error); } }
/** Exact selection on an attested terminal. Read-only preflight precedes writers; the application repeats validation. */
export async function applyConfiguredIdentityDistribution(root: string, raw: unknown, expect: string, options: ConfigLoadOptions = {}) { try {
    const parsed = identityDistributionSubmissionSchema.safeParse(raw); if (!parsed.success) throw new IdentityProfileError('IDENTITY_PREVIEW_INVALID');
    const submission = parsed.data, { config, registry, source } = await context(root, options);
    const reader = await openSqliteInventoryReader(await inspectProductFile(config.productLayout, 'ledger', ['-wal', '-shm', '-journal']), { busyTimeoutMs: config.storage.sqlite.busyTimeoutMs });
    try { await new IdentityProfileDistributionApplication(registry, source, { effects: reader, administration: { submit: async () => { throw new Error('read-only'); } } }).validateSubmission(submission, expect); } finally { reader.close(); }
    const scope = await loadConfiguredScopeContext(root, submission.selection.scopeId, options, 'read'); if (!scope.installationId || !scope.projectId) throw ErrorRegistry.createError('INSTALLATION_IDENTITY_UNAVAILABLE');
    const peer = localPrincipalPeer(); if (!await attestLocalInteractiveTerminal(peer?.pid, peer?.uid)) throw ErrorRegistry.createError('APPROVAL_INTERACTIVE_REQUIRED');
    return await withPolicyAdministration(root, submission.selection.scopeId, options, 'write', async deps => {
      if (!deps.effects) throw new IdentityProfileError('IDENTITY_PREVIEW_UNAVAILABLE');
      const app = new IdentityProfileDistributionApplication(registry, source, { administration: deps.administration, effects: deps.effects });
      const outcome = await app.applyConfirmed(submission, expect, deps.approve, t('identity.distributionReason', {}, config.language));
      return { schemaVersion: 1 as const, profile: submission.selection.profile, digest: expect, outcome }; });
  } catch (error) { return identityFailure(error); } }
