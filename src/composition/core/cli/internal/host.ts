import { SIWC_INFERENCE, SIWC_USAGE_SUMMARY, providerDiscoveryChannel, workingTreeChanges } from '#adapters/index.js';
import { executeConfiguredHub } from '#composition/core/hub/index.js';
import { inspectConfiguredRefusedRequests, planRuntimeRun } from '#composition/core/run-planner/index.js';
import { inspectInstallationStartability, readAutonomyShadow, createConfiguredRuntimeClient, configuredTargetQueueTerminal, invokeRuntimeModel, runRuntimeChatTurn, cancelRuntimeChatTurn, findRuntimeWorkspaceFiles, attachRuntimeWorkspaceFile, inspectRuntimeModelInvocation, purgeRuntimeModelInvocationContent, cancelRuntimeModelInvocation, inspectRuntimeProviderSpendAccount, auditRuntimeProviderSpendAccount, manageRuntimeProviderSpend } from '#composition/core/runtime-service/index.js';
import { configuredProjectInstructions } from '#composition/core/project-instructions/index.js';
import { executeConfiguredBackup, inspectConfiguredBackupSets, inspectConfiguredRecoveryFiles } from '#composition/core/backup/index.js';
import { inspectConfiguredAdminPaths } from './admin-paths.js';
import { previewConfiguredIdentityProfile, listIdentityProfiles, listConfiguredIdentityDistributionChoices, previewConfiguredIdentityDistribution, applyConfiguredIdentityDistribution } from '#composition/core/identity-profile/index.js';
import { ensureConfiguredTerminalIdentity, inspectConfiguredInstallationBinding, resolveConfiguredInstallationIdentity, loadConfiguredInstallationIdentity, loadConfiguredProjectIdentity } from '#composition/core/scoped-request/index.js';
import { unifiedDiff, readInstallationProfileFile, isSelfSourceProject, openExternalEditor, PROVIDER_CONNECT_KINDS, PROVIDER_CONNECT_LEGACY_KEYS, probeProviderConnection, providerEndpoint, providerConnectFamily, providerConnectKind, providerConnectModelPriced, providerConnectSecretName, readProviderConnectSeed } from '#adapters/index.js';
import { openDeliveryRuns, settledProviderCacheUsage } from '#engine/index.js';
import { composeCore, loadComposedConfig } from '#composition/core/root/index.js';
import { createConfiguredConfigApplication, resolveConfiguredConfigPrincipal, configuredConfigChoiceSources } from '#composition/core/config/index.js';
import { inspectConfiguredMemoryRollout } from '#composition/core/memory-rollout/index.js';
import { inspectConfiguredWorkerTranscript, inspectConfiguredWorkers } from '#composition/core/worker-observation/index.js';
import { inspectConfiguredMemory, listConfiguredMemory, searchConfiguredMemory, proposeConfiguredMemory, verifyConfiguredMemory, retireConfiguredMemory, inspectConfiguredMemoryEvaluators,
  reviewConfiguredMemory, listConfiguredMemorySource, purgeConfiguredMemory, resolveConfiguredMemoryContest, countConfiguredMemoryPurgesPending } from '#composition/core/memory/index.js';
import { listConfiguredAgents, inspectConfiguredAgent, listConfiguredSkills, inspectConfiguredSkill, defineConfiguredAgent, defineConfiguredSkill, importConfiguredSkill,
  listConfiguredSigners, enrolConfiguredSigner, addConfiguredSigner, revokeConfiguredSigner, repairConfiguredSigners, inspectConfiguredAgentStats, listConfiguredSuggestions, inspectConfiguredSuggestion,
  changeConfiguredStanding, dismissConfiguredSuggestion, bulkConfiguredStanding, listConfiguredRevokedPromotions, draftConfiguredSuggestion, defineConfiguredFromSuggestion, inspectConfiguredCatalogMonitor } from '#composition/core/agent-catalog/index.js';
import { prepareConfiguredDecision, askConfiguredDecision, recordConfiguredDecision, outcomeConfiguredDecision, inspectConfiguredDecision, listConfiguredDecisions } from '#composition/core/decision/index.js';
import { inspectMonitor, inspectSurfaceAccess, inspectSurfaceRunIds, followLedgerSurface } from '#composition/core/monitor/index.js';
import { inspectConfiguredToolchainCurrency, inspectConfiguredWorkerImage, updateConfiguredToolchains, inspectToolchainRefresh } from '#composition/core/toolchains/index.js';
import { executeConfiguredOperation, compensateConfiguredOperation, inspectConfiguredOperation } from '#composition/core/operations/index.js';
import { changeConfiguredDecisionDelegation, inspectConfiguredDecisionDelegations, configuredPolicyTemplateUpgrade, inspectConfiguredPolicyAdministration, listConfiguredAllStandingGrants, listConfiguredStandingGrants, revokeConfiguredStandingGrant, listConfiguredMcpCapabilityScopes, inspectConfiguredMcpCapabilities, changeConfiguredMcpCapabilities } from '#composition/core/approvals/index.js';
import { readConfiguredInferenceMetrics } from '#composition/core/inference-metrics/index.js';
import { changeConfiguredDeliveryDismissal, checkConfiguredWorkTarget, interactiveDeliveryHandlers, describeConfiguredDeliverySummaries, inspectConfiguredWorkspaceIntegration, checkConfiguredWorkspaceIntegration, prepareConfiguredWorkspaceIntegration, prepareConfiguredWorkspacePatch, previewConfiguredWorkspacePatch } from '#composition/core/workspace-patch/index.js';
import { admitConfiguredModelActivation, applyConfiguredModelCatalog, assignConfiguredModelRole, inspectConfiguredModelActivation, inspectConfiguredModelCatalog,
  inspectConfiguredModelRoles } from '#composition/core/model-activation/index.js';
import { inspectConfiguredSiwcConnections, executeConfiguredSiwc, connectProvider, prepareProviderSecret, connectConfiguredModel, listConfiguredConnectionWorkspaces, loginConfiguredHeadless, readConfiguredHeadlessLogins, listConfiguredConnectionModels, planConfiguredProfileCache, planConfiguredProfileProtocol, inspectConfiguredModelReadiness, prepareConfiguredModelSwitch } from '#composition/core/model-connect/index.js';
import { startConfiguredCliRuntimeService } from './runtime-host.js';
import { releaseConfiguredQuota, applyConfiguredPoolCapacity, inspectConfiguredPoolCapacity, applyConfiguredRunLifecycle, applyConfiguredPoolHold, createConfiguredDeliveryRun, inspectConfiguredPoolHold,
  inspectConfiguredWorkerInstructions, changeConfiguredWorkerInstructionTrust, inspectConfiguredRecoveryMode, inspectConfiguredRecoveryRollout, inspectConfiguredRecoveryPolicy,
  changeConfiguredRecoveryPolicy, configuredRecoveryReview, configuredLocalRunOffer } from '#composition/core/runs/index.js';
import { ensureConfiguredRuntimeService, managerRunning, openConfiguredTerminalHistory, openConfiguredTerminalSessions, restartConfiguredRuntimeService, stopConfiguredRuntimeService } from './runtime-autostart.js';
import { openConfigWindow, askDeliveryConfirmation, attachTerminalMentions, findTerminalMentions, streamTerminalAgentTurn, type main as runCli } from '#surfaces/index.js';
import { previewConfiguredUninstall, applyConfiguredUninstall, previewSuppliedInstallation, inspectSuppliedInstallation, applySuppliedInstallation, resumeInstallation, applyPolicyTemplateInstallationWithSecretDefault, inspectPolicyTemplate, inspectAnchoredPolicyTemplate, previewPolicyTemplateInstallation, upgradePolicyTemplateInstallation, openPermissionModesInstallation, openOwnerBaselineInstallation, inspectOwnerBaselineInstallation, openOwnPermissionMode, installConfiguredExecutionPool } from '#composition/core/installation/index.js';
import { builtinAgentToolClass, inspectConfiguredShellRealm, runConfiguredMcpCommand, chatTurnRoundCommandId } from '#composition/core/agent-turn/index.js';
import { getConfigFieldDefault, loadConfig, type Locale } from '#platform/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { recordConfiguredProviderFailure, inspectDeclaredModels, inspectModelBinding, openConfiguredProviderWorkspaces } from '#composition/core/provider-catalog/index.js';
import { prepareNativeCodingProfile, configureNativeCodingTemplate, initializeNativeCodingRegistry, addNativeCodingProfile } from '#composition/core/native-coding/index.js';
import { assertConfiguredTerminalCredential, assertTerminalChatReady, completeTerminalChatTurn, describeTerminalChat, terminalSecretGrantOffer } from '#composition/core/terminal-chat/index.js';
import { assessConfiguredModelInvocationDelivery, inspectConfiguredModelInvocationCommand, inspectConfiguredInvocableModels } from '#composition/core/model-invocation/index.js';
import { verifyConfiguredAudit, listConfiguredAudit, rebaselineConfiguredAudit } from '#composition/core/audit/index.js';
import { configuredSetup } from '#composition/core/setup/index.js';
import { assertConfiguredProjectCredential, changeProjectSecretGrant, handOverProjectSecrets, inspectConfiguredSecretInventory, inspectConfiguredSecretStore, listConfiguredSecretNames, listConfiguredSecretStores, setProjectSecret } from '#composition/core/secrets/index.js';

/** The call's settings the light entry resolved before any host module loaded. */
export type CliHostBase = { readonly root: string; readonly locale: Locale; readonly signal: AbortSignal } & Pick<NonNullable<Parameters<typeof runCli>[1]>, 'agentEnvironment'>;

/**
 * COLDSTART: every host operation of the CLI, bound to its composition unit. The entry loads this module only when a command or the terminal
 * runs (`loadHost`), so help, `--version` and an unknown command never evaluate the adapters and engine graph behind these imports.
 */
export function createCliHost(base: CliHostBase, serviceEntry?: string): Parameters<typeof runCli>[1] & object {
  const { root, locale, signal } = base, runtime = createConfiguredRuntimeClient(root);
  const delivery = interactiveDeliveryHandlers(async view => askDeliveryConfirmation(view, locale, process.stdin, process.stderr,
    { timeoutMs: (await loadConfig(root)).approvals.sessionTtlMs, signal }));
  const host: Parameters<typeof runCli>[1] & object = { ...base, initialize: composeCore, startRuntimeService: startConfiguredCliRuntimeService,
    walkBeuser: async (...args) => (await import('#composition/core/beuser/index.js')).walkConfiguredBeuser(...args).catch(error => { throw queryFailure(error); }),
    readBeuserReport: async (...args) => (await import('#composition/core/beuser/index.js')).readConfiguredBeuserReport(...args),
    setupBeuser: async (...args) => (await import('#composition/core/beuser/index.js')).setupConfiguredBeuser(...args).catch(error => { throw queryFailure(error); }),
    verifyAudit: verifyConfiguredAudit, listAudit: listConfiguredAudit, rebaselineAudit: rebaselineConfiguredAudit, executeBackup: executeConfiguredBackup, previewIdentityProfile: previewConfiguredIdentityProfile, listIdentityProfiles,
    listIdentityDistributionChoices: listConfiguredIdentityDistributionChoices, previewIdentityDistribution: previewConfiguredIdentityDistribution, applyIdentityDistribution: applyConfiguredIdentityDistribution,
    executeHub: (root, request, options, signal) => executeConfiguredHub(root, request, options, {}, signal), prepareDecision: prepareConfiguredDecision, askDecision: askConfiguredDecision, recordDecision: recordConfiguredDecision, outcomeDecision: outcomeConfiguredDecision, inspectDecision: inspectConfiguredDecision, listDecisions: listConfiguredDecisions, listAgents: listConfiguredAgents, inspectAgent: inspectConfiguredAgent, listSkills: listConfiguredSkills, inspectSkill: inspectConfiguredSkill, defineAgent: defineConfiguredAgent, defineSkill: defineConfiguredSkill, inspectAgentStats: inspectConfiguredAgentStats, inspectCatalogMonitor: inspectConfiguredCatalogMonitor, importSkill: importConfiguredSkill, listSigners: listConfiguredSigners, enrolSigner: enrolConfiguredSigner, addSigner: addConfiguredSigner, revokeSigner: revokeConfiguredSigner, repairSigners: repairConfiguredSigners, listSuggestions: listConfiguredSuggestions, inspectSuggestion: inspectConfiguredSuggestion, changeStanding: changeConfiguredStanding, dismissSuggestion: dismissConfiguredSuggestion, bulkStanding: bulkConfiguredStanding, listRevokedPromotions: listConfiguredRevokedPromotions, draftSuggestion: draftConfiguredSuggestion, defineFromSuggestion: defineConfiguredFromSuggestion,
    listMemory: listConfiguredMemory, searchMemory: searchConfiguredMemory, inspectMemory: inspectConfiguredMemory, proposeMemory: proposeConfiguredMemory, verifyMemory: verifyConfiguredMemory, retireMemory: retireConfiguredMemory, inspectMemoryEvaluators: inspectConfiguredMemoryEvaluators,
    reviewMemory: reviewConfiguredMemory, listMemorySource: listConfiguredMemorySource, purgeMemory: purgeConfiguredMemory, resolveMemoryContest: resolveConfiguredMemoryContest,
    inspectMemoryRollout: inspectConfiguredMemoryRollout,
    countMemoryPurgesPending: countConfiguredMemoryPurgesPending,
    ...configuredTargetQueueTerminal(root),
    deliverWorkspaceIntegration: delivery.deliver,
    adoptWorkspaceIntegration: delivery.adopt, rollbackWorkspaceIntegration: delivery.rollback, interactiveDelivery: interactiveDeliveryHandlers, // TESLIM-PENCERESI window answer
    inspectWorkerTranscript: inspectConfiguredWorkerTranscript, executeOperation: executeConfiguredOperation, compensateOperation: compensateConfiguredOperation, inspectOperation: inspectConfiguredOperation,
    inspectWorkspaceIntegration: inspectConfiguredWorkspaceIntegration, describeDeliverySummaries: describeConfiguredDeliverySummaries, // TESLIM-KARTI-OZET card summaries
    // OTONOM-TESLIM shadow (B1 store): read only for tickets the service already returned to this person (list/inspect); never on a consent card.
    readAutonomyShadow: async (projectRoot, scopeId, commandId, options) => readAutonomyShadow((await loadComposedConfig(projectRoot, { ...options, heal: false })).productLayout, scopeId, commandId),
    checkWorkspaceIntegration: checkConfiguredWorkspaceIntegration, prepareWorkspaceIntegration: prepareConfiguredWorkspaceIntegration,
    prepareWorkspacePatch: prepareConfiguredWorkspacePatch, previewWorkspacePatch: previewConfiguredWorkspacePatch, renderUnifiedDiff: unifiedDiff,
    configChoiceSources: (root, options) => ({ ...configuredConfigChoiceSources(root, options), checkWorkTarget: async workTargets => checkConfiguredWorkTarget(root, workTargets, options,
      await inspectMonitor(root, options).then(openDeliveryRuns, () => [])) }), /* BeUser DR2-05: the open results a work-source move strands */ configApplication: createConfiguredConfigApplication, resolveConfigPrincipal: resolveConfiguredConfigPrincipal,
    listRefusedRequests: (root, scopeId, limit, options) => inspectConfiguredRefusedRequests(root, scopeId, limit, options), // BeUser D-08
    changeDeliveryDismissal: changeConfiguredDeliveryDismissal, // BeUser M-33
    openConfigPanel: openConfigWindow, // C-SETUP: `deckent config` on a terminal = the `/config` window (lazy view)
    inspectToolchainRefresh,
    inspectWorkers: inspectConfiguredWorkers, inspectMonitor, inspectToolchainCurrency: (projectRoot, options) => inspectConfiguredToolchainCurrency(projectRoot, options), inspectSurfaceAccess, inspectSurfaceRunIds, followSurfaceEvents: followLedgerSurface,
    ensureRuntimeService: (projectRoot, options) => ensureConfiguredRuntimeService(projectRoot, options, undefined, serviceEntry),
    restartRuntimeService: (projectRoot, options) => restartConfiguredRuntimeService(projectRoot, options, undefined, serviceEntry), runningImageBuild: async (projectRoot, options) => ['requested', 'waiting-docker', 'acquiring'].includes((await inspectConfiguredWorkerImage(projectRoot, options).catch(() => null))?.phase ?? ''), localRunOffer: configuredLocalRunOffer, workingTreeChanges: (projectRoot, options) => workingTreeChanges(projectRoot, options.env ?? process.env),
    openProjectInstructions: configuredProjectInstructions,
    openTerminalHistory: (projectRoot, options) => openConfiguredTerminalHistory(projectRoot, options),
    openTerminalSessions: (projectRoot, options, folder) => openConfiguredTerminalSessions(projectRoot, options, folder), externalEditor: openExternalEditor({ env: process.env }),
    selfSourceProject: isSelfSourceProject,
    ensureTerminalIdentity: (projectRoot, scopeId, options) => ensureConfiguredTerminalIdentity(projectRoot, scopeId, options).catch(error => { throw queryFailure(error); }),
    resolveInstallationIdentity: resolveConfiguredInstallationIdentity, loadInstallationIdentity: loadConfiguredInstallationIdentity, loadProjectIdentity: loadConfiguredProjectIdentity,
    stopRuntimeService: (projectRoot, options, reason) => stopConfiguredRuntimeService(projectRoot, options, reason), inspectBackupSets: inspectConfiguredBackupSets, inspectAdminPaths: inspectConfiguredAdminPaths,
    readInferenceMetrics: (projectRoot, input, options) => readConfiguredInferenceMetrics(projectRoot, input, options),
    updateToolchains: (projectRoot, input, options) => updateConfiguredToolchains(projectRoot, input, options),
    runMcpCommand: runConfiguredMcpCommand,
    inspectSecretStore: inspectConfiguredSecretStore, listSecretNames: listConfiguredSecretNames, inspectRecoveryFiles: inspectConfiguredRecoveryFiles, inspectRecoveryMode: inspectConfiguredRecoveryMode,
    inspectInstallationBinding: inspectConfiguredInstallationBinding,
    inspectInstallationStartability, inspectShellRealm: inspectConfiguredShellRealm, // REALM-NOTICE: doctor's selected shell realm and every provider passed over.
    prepareMainSecret: prepareProviderSecret, connectProviderSecret: connectProvider,
    setSecret: (projectRoot, input, options) => createConfiguredRuntimeClient(projectRoot, options).setSecret(input),
    /* T4 PROVIDER-CONNECT: the /provider kinds (adapter data) and the free check, run in this terminal process with the key the person typed; the key then goes only to `setSecret` above (runtime service, audited by name). No environment variable, file or worker sees it. */ providerConnect: { kinds: PROVIDER_CONNECT_KINDS.map(kind => ({ id: kind.id, labelKey: kind.labelKey, available: kind.available, endpointDefault: kind.endpoint.default,
      endpointEditable: kind.endpoint.editable, keyRequired: kind.key?.required ?? false, secretName: kind.key?.secretName ?? null, probePath: kind.probe?.path ?? null,
      endpointChoices: kind.endpoint.choices, catalogProviderId: kind.connect?.seed ?? (kind.connect?.adapter === SIWC_INFERENCE.adapter.id ? providerDiscoveryChannel(kind, null) : null), connectFamily: providerConnectFamily(kind), seeded: Boolean(kind.connect?.seed),
      priceRequired: kind.connect?.priceRequired ?? false, billing: kind.billing, ...(kind.connect ? { pull: kind.connect.pull } : {}) })),
    endpoint: providerEndpoint, probe: async (input, signal) => { const result = await probeProviderConnection(input, signal ? { signal } : {});
      if (result.cause) await recordConfiguredProviderFailure(base.root, 'provider-probe', { code: 'PROVIDER_PROBE_REFUSED', cause: result.cause, status: result.httpStatus }); return result; },
    legacyKeys: PROVIDER_CONNECT_LEGACY_KEYS,
    /* T4-B: the per-connection key name (the generic row derives it from the host) and a seeded kind's models (exact ids from its packaged seed). */ secretName: (id, endpoint) => { const kind = providerConnectKind(id); if (!kind) return null; const base = endpoint === null ? null : providerEndpoint(endpoint);
      return providerConnectSecretName(kind, base?.ok ? base.base : null); },
    discoverModels: listConfiguredConnectionModels, workspaces: listConfiguredConnectionWorkspaces,
    seedModels: async id => { const kind = providerConnectKind(id), seed = kind?.connect?.seed; if (!kind || !seed) return [];
      return (await readProviderConnectSeed(seed)).providers.flatMap(provider => provider.models.map(model => ({ nativeId: model.nativeId,
        displayName: (model as { displayName?: string }).displayName ?? model.nativeId, priced: providerConnectModelPriced(kind, model.nativeId) }))); } },
    deleteSecret: (projectRoot, input, options) => createConfiguredRuntimeClient(projectRoot, options).deleteSecret(input),
    // PRE-8 v2: the inventory, grants, project-vault changes and the handover run in this process at the person's witnessed terminal (no protocol op).
    inspectSecretInventory: (projectRoot, input, options) => inspectConfiguredSecretInventory(projectRoot, input.scopeId, input.all, options).catch(error => { throw queryFailure(error); }),
    changeSecretGrant: (projectRoot, input, options) => changeProjectSecretGrant(projectRoot, input.scopeId, input.name, input.action, 'admin', options).catch(error => { throw queryFailure(error); }),
    setProjectSecret: (projectRoot, input, options) => setProjectSecret(projectRoot, input.scopeId, input.name, input.value, options).catch(error => { throw queryFailure(error); }),
    handOverSecrets: (projectRoot, input, options) => handOverProjectSecrets(projectRoot, input.scopeId, options).catch(error => { throw queryFailure(error); }),
    listSecretStores: listConfiguredSecretStores,
    switchSecretStore: (projectRoot, input, options) => createConfiguredRuntimeClient(projectRoot, options).switchSecretStore(input),
    // alpha.53 F1: the worker instruction file's trust, in this process at the person's witnessed terminal (no protocol op).
    inspectWorkerInstructions: (projectRoot, options) => inspectConfiguredWorkerInstructions(projectRoot, options).catch(error => { throw queryFailure(error); }),
    changeWorkerInstructionTrust: (projectRoot, input, options) => changeConfiguredWorkerInstructionTrust(projectRoot, input, options).catch(error => { throw queryFailure(error); }),
    inspectDeclaredModels, inspectModelBinding, prepareCodingProfile: prepareNativeCodingProfile, configureCodingTemplate: configureNativeCodingTemplate, initializeNativeCodingRegistry, addCodingProfile: addNativeCodingProfile,
    clearSessionStanding: input => runtime.clearSessionStanding(input), renewApproval: input => runtime.renewApproval(input), listApprovals: input => runtime.listApprovals(input), inspectApproval: input => runtime.inspectApproval(input), decideApproval: input => runtime.decideApproval(input),
    invokeModel: invokeRuntimeModel,
    planRun: planRuntimeRun,
    describeTerminalChatPlan: describeTerminalChat,
    completeTerminalChat: (projectRoot, input, options, signal) => completeTerminalChatTurn({ projectRoot, ...input, options, ...(signal ? { signal } : {}) },
      { invoke: invokeRuntimeModel, cancel: cancelRuntimeModelInvocation }),
    // PRE-8 first-use card (lead fan-in): the card is UX; the grant is the governed `secret grant` (secret/set cell, terminal witness, sealed decision).
    secretGrantCard: { offer: terminalSecretGrantOffer, grant: (root, scopeId, name, opts) => changeProjectSecretGrant(root, scopeId, name, 'grant', 'card', opts).then(() => {}),
      check: (root, scopeId, name, opts) => assertConfiguredProjectCredential(root, scopeId, name, opts).catch(error => { throw queryFailure(error); }) },
    streamTerminalChat: (projectRoot, input, options, signal) => streamTerminalAgentTurn({ projectRoot, ...input, options, ...(signal ? { signal } : {}) },
      { chatTurn: runRuntimeChatTurn, cancelChatTurn: cancelRuntimeChatTurn, preflight: assertTerminalChatReady, toolClass: builtinAgentToolClass,
        // PRE-8 v2: the provider credential decision before the turn binds (no value read); SECRET_GRANT_REQUIRED opens the first-use card.
        credential: (root, opts, reference, scope) => assertConfiguredTerminalCredential(root, reference, scope, opts).catch(error => { throw queryFailure(error); }),
        settledUsage: async (root, command, round, options) => {
          const reference = command.reference ?? (await describeTerminalChat(root, options)).reference;
          return settledProviderCacheUsage((reference ? await inspectConfiguredModelInvocationCommand(root, { schemaVersion: 1, scopeId: command.scopeId,
            commandId: chatTurnRoundCommandId(command.scopeId, command.turnId, round), reference }, options) : null)?.spending ?? null);
        } }),
    findTerminalMentions: (projectRoot, input, options, signal) => findTerminalMentions({ projectRoot, ...input, options, ...(signal ? { signal } : {}) },
      { find: findRuntimeWorkspaceFiles, attach: attachRuntimeWorkspaceFile }),
    attachTerminalMentions: (projectRoot, input, options, signal) => attachTerminalMentions({ projectRoot, ...input, options, ...(signal ? { signal } : {}) },
      { find: findRuntimeWorkspaceFiles, attach: attachRuntimeWorkspaceFile }),
    openOwnPermissionMode,
    inspectPermissionMode: (projectRoot, input, options, signal) => createConfiguredRuntimeClient(projectRoot, options).inspectPermissionMode(input, signal),
    setPermissionMode: (projectRoot, input, options) => createConfiguredRuntimeClient(projectRoot, options).setPermissionMode(input),
    inspectScratch: (projectRoot, input, options, signal) => createConfiguredRuntimeClient(projectRoot, options).inspectScratch(input, signal),
    clearScratch: (projectRoot, input, options) => createConfiguredRuntimeClient(projectRoot, options).clearScratch(input),
    inspectModelInvocation: inspectRuntimeModelInvocation, purgeModelInvocationContent: purgeRuntimeModelInvocationContent,
    cancelModelInvocation: cancelRuntimeModelInvocation, inspectProviderSpendAccount: inspectRuntimeProviderSpendAccount, auditProviderSpendAccount: auditRuntimeProviderSpendAccount, manageProviderSpend: manageRuntimeProviderSpend,
    admitModelActivation: admitConfiguredModelActivation, inspectModelActivation: inspectConfiguredModelActivation, applyModelCatalog: applyConfiguredModelCatalog, inspectModelCatalog: inspectConfiguredModelCatalog,
    siwc: { connection: PROVIDER_CONNECT_KINDS.find(row => row.connect?.adapter === SIWC_INFERENCE.adapter.id)!.id, usageUrl: SIWC_USAGE_SUMMARY.manageUrl, execute: executeConfiguredSiwc },
    inspectSiwcConnections: inspectConfiguredSiwcConnections,
    inspectModelRoles: inspectConfiguredModelRoles, readHeadlessLogins: readConfiguredHeadlessLogins, loginHeadless: loginConfiguredHeadless, assignModelRole: (projectRoot, command, options) => assignConfiguredModelRole(projectRoot, command, options), // M2 typed role admission
    /* T4-B models.connect: the secret store is read for names only (the key's presence), the service describe for the restart state. */ planProfileCache: planConfiguredProfileCache, // CACHE-SLICE1: the governed 5-minute cache migration offered in `/model` and `/provider`.
    inspectModelReadiness: inspectConfiguredModelReadiness, prepareModelSwitch: prepareConfiguredModelSwitch, inspectInvocableModels: inspectConfiguredInvocableModels,
    planProfileProtocol: planConfiguredProfileProtocol, openProviderWorkspaces: openConfiguredProviderWorkspaces,
    connectModel: (projectRoot, command, options) => connectConfiguredModel(projectRoot, command, options, { listSecretNames: listConfiguredSecretNames,
      describeService: (describeRoot, describeOptions) => createConfiguredRuntimeClient(describeRoot, describeOptions).describeService() }),
    releaseQuota: releaseConfiguredQuota, applyPoolCapacity: applyConfiguredPoolCapacity, inspectPoolCapacity: inspectConfiguredPoolCapacity, applyRunLifecycle: applyConfiguredRunLifecycle, applyPoolHold: applyConfiguredPoolHold, inspectPoolHold: inspectConfiguredPoolHold, // K5 typed pool hold (local, ledger-read by the service)
    previewUninstall: (root, query, options) => previewConfiguredUninstall(root, query, options).catch(error => { throw queryFailure(error); }),
    applyUninstall: (root, input, interaction, options, signal) => applyConfiguredUninstall(root, input, interaction, options, signal).catch(error => { throw queryFailure(error); }),
    previewInstallation: async (projectRoot, input) => {
      try { return await previewSuppliedInstallation(projectRoot,
        await readInstallationProfileFile(input.profilePath, getConfigFieldDefault('installation').profileMaxBytes),
        { allowShutdown: input.allowShutdown }); }
      catch (error) { throw queryFailure(error); }
    },
    inspectInstallation: async (projectRoot, input) => {
      try { return await inspectSuppliedInstallation(projectRoot,
        await readInstallationProfileFile(input.profilePath, getConfigFieldDefault('installation').profileMaxBytes),
        { allowShutdown: input.allowShutdown, dockerExecutable: input.dockerExecutable }); }
      catch (error) { throw queryFailure(error); }
    },
    applyInstallation: async (projectRoot, input) => {
      try { return await applySuppliedInstallation(projectRoot,
        await readInstallationProfileFile(input.profilePath, getConfigFieldDefault('installation').profileMaxBytes),
        { allowShutdown: input.allowShutdown, dockerExecutable: input.dockerExecutable,
          proposalDigest: input.proposalDigest, acceptCustom: input.acceptCustom }); }
      catch (error) { throw queryFailure(error); }
    },
    resumeInstallation: async (projectRoot, input) => {
      try { return await resumeInstallation(projectRoot, input); }
      catch (error) { throw queryFailure(error); }
    },
    previewPolicyTemplateInstallation: (projectRoot, scopeId) => previewPolicyTemplateInstallation(projectRoot, scopeId).catch(error => { throw queryFailure(error); }),
    applyPolicyTemplateInstallation: (projectRoot, scopeId) => applyPolicyTemplateInstallationWithSecretDefault(projectRoot, scopeId).catch(error => { throw queryFailure(error); }),
    openOwnerBaselineInstallation: (projectRoot, scopeId, input) => openOwnerBaselineInstallation(projectRoot, scopeId, input),
    openPermissionModesInstallation: (projectRoot, scopeId, input) => openPermissionModesInstallation(projectRoot, scopeId, input),
    upgradePolicyTemplateInstallation: (projectRoot, scopeId, apply, expect, person) => upgradePolicyTemplateInstallation(projectRoot, scopeId, apply, expect, {}, process.getuid?.(), person)
      .catch(error => { throw queryFailure(error); }),
    installConfiguredExecutionPool: (projectRoot, scopeId, apply) => installConfiguredExecutionPool(projectRoot, scopeId, apply).catch(error => { throw queryFailure(error); }),
    inspectOwnerBaseline: inspectOwnerBaselineInstallation,
    inspectPolicyTemplate: (projectRoot, options) => inspectPolicyTemplate(projectRoot, options), inspectAnchoredPolicyTemplate,
    assessModelInvocationDelivery: (projectRoot, options) => assessConfiguredModelInvocationDelivery(projectRoot, options),
    listStandingGrants: listConfiguredStandingGrants, listAllStandingGrants: listConfiguredAllStandingGrants, revokeStandingGrant: revokeConfiguredStandingGrant,
    inspectPolicyAdministration: inspectConfiguredPolicyAdministration,
    upgradePolicyTemplate: (root, scopeId, input, options) => configuredPolicyTemplateUpgrade(root, scopeId, options, input).catch(error => { throw queryFailure(error); }),
    delegations: { inspect: inspectConfiguredDecisionDelegations, change: changeConfiguredDecisionDelegation },
    // alpha.56: lost-worker recovery cards, in this process at the person's witnessed terminal (no protocol op); the rollout read for doctor too.
    inspectRecoveryRollout: inspectConfiguredRecoveryRollout, recovery: { inspectRollout: inspectConfiguredRecoveryRollout, inspectPolicy: inspectConfiguredRecoveryPolicy,
      changePolicy: changeConfiguredRecoveryPolicy, reviewPending: (projectRoot, input, options) => configuredRecoveryReview(projectRoot, input.scopeId, options, (review, person) => review.pending(input, person)),
      reviewAnswer: (projectRoot, input, options) => configuredRecoveryReview(projectRoot, input.scopeId, options, (review, person) => review.answer(input, person)) },
    mcpCapabilities: { listMcpCapabilityScopes: listConfiguredMcpCapabilityScopes, inspectMcpCapabilities: inspectConfiguredMcpCapabilities, changeMcpCapabilities: changeConfiguredMcpCapabilities },
    describeRuntimeService: (_root, options) => createConfiguredRuntimeClient(_root, options).describeService(), runtimeServiceManager: managerRunning,
    shutdownRuntimeService: (_root, command, options) => createConfiguredRuntimeClient(_root, options).shutdownService(command),
    inspectInventory: (_root, input) => runtime.inspectInventory(input), inspectRun: (_root, input) => runtime.inspectRun(input),
    deliverRunCancellation: (_root, input) => runtime.deliverRunCancellation(input),
    reserveRunTasks: (_root, input) => runtime.reserveRunTasks(input),
    proposeRun: (_root, input) => runtime.proposeRun(input), inspectRunProposal: (_root, input) => runtime.inspectRunProposal(input),
    createRun: (_root, input) => runtime.createRun(input), createDeliveryRun: createConfiguredDeliveryRun,
    executeTask: (_root, input) => runtime.executeTask(input), evaluateTask: (_root, input) => runtime.evaluateTask(input),
  };
  return { ...host, ...configuredSetup(host) }; // I-S3: bare `deckent init`
}
