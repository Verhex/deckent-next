import { previewFirstCommit, observeFirstCommitRecovery } from '#adapters/index.js';
import { randomUUID } from 'node:crypto';
import { opendir, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { userInfo } from 'node:os';
import { planSetup, affectedToolchainProfiles, assertAuthorityWitness, RunPolicyAuthorization, type SetupStage, type RunIntentRecord } from '#engine/index.js';
import { ErrorRegistry, sha256, loadConfig, productResourcePath, prepareProductFile, type ConfigLoadOptions } from '#platform/index.js';
import { openOnboardingDeferrals, openSqliteRunProposalReader, attestLocalInteractiveTerminal, localPrincipalChannel } from '#adapters/index.js';
import { loadModelsSurface } from '#surfaces/index.js';
import type { TerminalLaunchContext } from '#surfaces/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { consentConfiguredWorkerImage } from '#composition/core/toolchains/index.js';
import { startConfiguredRunIntent, transitionConfiguredRunIntent } from '#composition/core/run-planner/index.js';
import { snapshotConfiguredConfig } from '#composition/core/config/index.js';
import { previewOnboardingConsent } from './consent-preview.js';
import type { AddCodingProfile, configuredSetup } from './wiring.js';
import { observeSetupPermissions, applySetupPermissions } from './permissions.js';
import { applyConfiguredFirstCommit } from './first-commit.js';
/** Trusted host binding. Canonical launch-folder and authenticated principal are derived here, never accepted as authority from UI answers. */
export async function configuredOnboarding(host: object, setup: Pick<ReturnType<typeof configuredSetup>, 'observeSetup' | 'applySetupStage'>,
  root: string, scopeId: string, launchFolder: string, options: ConfigLoadOptions) {
  const context = await loadConfiguredScopeContext(root, scopeId, options, 'read'), terminal = host as TerminalLaunchContext;
  const base = await realpath(root), directory = await realpath(join(base, launchFolder)), folder = relative(base, directory).split(sep).join('/');
  if (folder === '..' || folder.startsWith('../')) throw ErrorRegistry.createError('LAYOUT_ROOT_INVALID');
  const principal = JSON.stringify([context.principal.issuer, context.principal.subject]);
  const path = productResourcePath(context.layout, 'onboarding'), store = openOnboardingDeferrals(path);
  const assertPerson = async () => {
    await assertAuthorityWitness('onboarding', localPrincipalChannel(), { attest: () => attestLocalInteractiveTerminal() });
    const fresh = await loadConfiguredScopeContext(root, scopeId, options, 'write');
    if (JSON.stringify([fresh.principal.issuer, fresh.principal.subject]) !== principal) throw ErrorRegistry.createError('RUN_PROPOSAL_ACTOR_MISMATCH');
  };
  // alpha.60 B: `signal` ends an observation nobody waits for any more (the terminal closed): no further step starts; this observe writes nothing.
  const observe = async (answers: Readonly<Record<string, unknown>>, signal?: AbortSignal) => {
    const before = await snapshotConfiguredConfig(root, options);
    const observed = await setup.observeSetup(root, { ...options, person: true, answers, ...(signal ? { signal } : {}) });
    signal?.throwIfAborted();
    const config = await loadConfig(root, { ...options, force: true, heal: false });
    const after = await snapshotConfiguredConfig(root, options);
    if (before.digest !== after.digest || JSON.stringify(before.global) !== JSON.stringify(after.global)) throw ErrorRegistry.createError('CONFIG_CONCURRENT_REVISION_HOLD');
    const configBasis = { projectDigest: after.digest, globalDigest: sha256(JSON.stringify(after.global)) };
    const coding = observed.observation.families?.['coding'] as { repository: string; hosts: { id: string; cli: string; login: string }[] } | undefined;
    const provider = (observed.observation.families?.['work'] as { pendingProvider?: string } | undefined)?.pendingProvider ?? affectedToolchainProfiles(config)[0]?.provider;
    const values = { ...(provider ? { 'work:kind': provider } : {}), ...answers };
    const planned = planSetup(observed.observation, { schemaVersion: 2, values }, observed.registry, { phase: 'onboarding' });
    const worker = (observed.observation.families?.['execution'] as { worker?: { acquisition?: { images: { provider: string; imageId: string }[] } | null } } | undefined)?.worker;
    const selectedImage = worker?.acquisition?.images.find(row => row.provider === values['work:kind'])?.imageId ?? null;
    const eligible = coding?.repository === 'present' && coding.hosts.some(row => row.cli === 'found');
    const stages = planned.stages;
    const names: string[] = []; let inspected = false;
    try { const dir = await opendir(directory); inspected = true; for await (const entry of dir) { if (names.length >= 64) break; if (entry.isFile() || entry.isDirectory()) names.push(entry.name); } } catch { /* unknown remains explicit */ }
    const visible = names.filter(name => !name.startsWith('.'));
    const kind = eligible ? 'coding' as const : !inspected ? 'unknown' as const : !visible.length ? 'empty' as const : 'documents' as const;
    let budgetReason: string | undefined; const { SCOPE_BUDGET_CHOICES } = await loadModelsSurface();
    const account = terminal.inspectProviderSpendAccount ? await terminal.inspectProviderSpendAccount(root, { schemaVersion: 1, scopeId, current: true }, options)
      .catch((error: unknown) => { const code = (error as { code?: unknown })?.code; budgetReason = typeof code === 'string' && ErrorRegistry.has(code) ? code : 'INVENTORY_UNAVAILABLE'; return null; }) : null;
    const currentUsd = budgetReason ? null : account?.checkpoint ? account.checkpoint.account.budget.limitMinorUnits / SCOPE_BUDGET_CHOICES.minorUnitsPerUsd : 0;
    // Billing comes from the connected model's registry/profile, not a provider-name list.
    signal?.throwIfAborted(); const chat = await terminal.describeTerminalChatPlan?.(root, options);
    // İ-2 is about a usable model (the same read as the /model window), not only the worker catalog; an unreadable answer counts as none.
    const modelUsable = (await terminal.inspectInvocableModels?.(root, scopeId, options).catch(() => null))?.models.some(row => row.availability.invocable) ?? false;
    const binding = terminal.providerConnect?.kinds.find(row => row.catalogProviderId === chat?.reference?.providerId);
    signal?.throwIfAborted(); const pending: RunIntentRecord[] = [];
    const reader = await openSqliteRunProposalReader(await context.path(), config.storage.sqlite);
    try {
      const auth = new RunPolicyAuthorization(createLayoutPolicySource(context.layout, userInfo().uid, config.inspection.policyMaxBytes));
      for (const intent of await reader.listIntents(scopeId)) {
        if (JSON.stringify(intent.proposer) !== JSON.stringify({ id: context.principal.id, issuer: context.principal.issuer, subject: context.principal.subject })) continue;
        await auth.authorize('inspect', { scopeId, runId: intent.runId }, context.principal);
        pending.push(intent);
      }
    } finally { reader.close(); }
    return { configBasis, plan: planned, observation: observed.observation, answers: values, deferred: (await store.list(principal, folder)).map(row => row.stageId),
      modelUsable, localRun: await terminal.localRunOffer?.(root, scopeId, options).catch(() => false) ?? false, folder, folderFacts: { kind, entries: visible }, scopeId,
      ready: { provider: typeof values['work:kind'] === 'string' ? values['work:kind'] : null, imageId: selectedImage, fallbackBefore: config.execution?.docker?.imageId ?? null, fallbackAfter: stages.find(row => row.id === 'execution:worker-settings')?.operation ? selectedImage : config.execution?.docker?.imageId ?? selectedImage },
      admittedProviders: (observed.observation.families?.['work'] as { providers?: readonly string[] } | undefined)?.providers ?? [],
      hosts: coding?.hosts ?? [], budget: { needed: binding?.billing === 'metered' && (currentUsd === 0 || currentUsd === null), presetUsd: SCOPE_BUDGET_CHOICES.defaultPresetUsd,
        presetsUsd: SCOPE_BUDGET_CHOICES.presetsUsd, currentUsd, ...(budgetReason ? { reason: budgetReason } : {}) }, permissions: await observeSetupPermissions(root, scopeId, options), pending, ...await rights() };
  };
  const baseline = (apply: boolean, expect?: string) => terminal.openOwnerBaselineInstallation!(root, scopeId, { families: ['mcp-delegable'], apply, ...(expect ? { expect } : {}) }); // BeUser ZEY-02/D-04: the existing founder card
  const rights = async () => { const view = terminal.openOwnerBaselineInstallation ? await baseline(false).catch(() => null) : null; return view ? { rights: { state: view.status === 'preview' ? 'needed' as const : view.status === 'current' ? 'current' as const : 'unavailable' as const, ...(view.expect ? { digest: view.expect } : {}), rules: view.added.length } } : {}; };
  return { observe, assertPerson, async rights(digest: string) { await assertPerson(); return { status: (await baseline(true, digest)).status }; },
    async previewFirstCommit(message: string, include: readonly string[] = []) {
      await assertPerson(); return previewFirstCommit({ root: directory, env: options.env ?? process.env, message, include });
    },
    async firstCommit(input: Readonly<{ message: string; digest: string; include?: readonly string[] }>, signal?: AbortSignal) {
      await assertPerson(); return applyConfiguredFirstCommit(root, directory, scopeId, input, options, signal);
    },
    async firstCommitRecovery() { await assertPerson(); return observeFirstCommitRecovery(directory, options.env ?? process.env); },
    async previewPermissions(profile?: Readonly<{ id: string; version: number }>) { await assertPerson(); return observeSetupPermissions(root, scopeId, options, profile); },
    async permissions(digest: string, profile?: Readonly<{ id: string; version: number }>) { await assertPerson(); await applySetupPermissions(root, scopeId, digest, options, undefined, profile); },
    async previewProfile(stage: SetupStage) {
      await assertPerson(); const input = stage.operation?.input ?? {};
      const result = await (host as { addCodingProfile?: AddCodingProfile }).addCodingProfile!(root, { provider: input['provider'], kind: input['kind'], image: input['image'], apply: false }, options);
      return { digest: result.digest, expect: result.expect, profile: `${result.profile.id}@${result.profile.version}`,
        provider: String(input['provider']), image: String(input['image']), kind: String(input['kind']) };
    },
    async defer(stageId: string, planDigest: string) { await assertPerson(); await prepareProductFile(context.layout, 'onboarding');
      await store.defer({ principal, folder, stageId, planDigest, deferredAt: Date.now() }); }, async settle(stageIds: readonly string[]) { await assertPerson(); await store.settle(principal, folder, stageIds); },
    async apply(stage: SetupStage, basis: Readonly<{ projectDigest: string | null; globalDigest: string }>) { await assertPerson(); return setup.applySetupStage(root, stage, { ...options, scopeId, expectedConfig: basis }); },
    async previewConsent(provider: string) { await assertPerson(); return previewOnboardingConsent(root, provider, options); },
    async consent(provider: string, digest: string, imageId?: string) {
      await assertPerson();
      const offered = imageId ? await previewOnboardingConsent(root, provider, options) : null;
      if (imageId && !offered?.images.some(image => image.imageId === imageId && image.ready)) throw ErrorRegistry.createError('WORKER_LABEL_MISMATCH');
      const witness = { attest: async () => {
        if ((await previewOnboardingConsent(root, provider, options, false)).digest !== digest) throw ErrorRegistry.createError('CONFIG_CONCURRENT_REVISION_HOLD');
        return attestLocalInteractiveTerminal();
      } };
      await consentConfiguredWorkerImage(root, { providers: [provider], scopeId, commandId: randomUUID(), ...(imageId ? { imageId } : {}) }, options, witness);
    },
    async budget(usd: number) {
      await assertPerson(); if (!terminal.manageProviderSpend || !terminal.inspectProviderSpendAccount) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
      const account = await terminal.inspectProviderSpendAccount(root, { schemaVersion: 1, scopeId, current: true }, options);
      const { scopeBudgetCreateCommand, scopeBudgetRevisionCommand } = await loadModelsSurface();
      const command = account.checkpoint ? scopeBudgetRevisionCommand(account, usd, false, 'terminal') : scopeBudgetCreateCommand(scopeId, usd, 'terminal');
      if (command) await terminal.manageProviderSpend(root, command, options); // Null: the budget already has this amount.
    },
    async reconcile(intent: RunIntentRecord) { return (await transitionConfiguredRunIntent(root, intent, 'fact', `${intent.command.commandId}-fact-${intent.fact.id}-${intent.fact.revision}`, options)).intent; },
    start: (intent: RunIntentRecord, signal?: AbortSignal) => startConfiguredRunIntent(root, intent, options, signal),
    async cancel(intent: RunIntentRecord) { await transitionConfiguredRunIntent(root, intent, 'cancel', `${intent.command.commandId}-cancel`, options); },
  };
}
