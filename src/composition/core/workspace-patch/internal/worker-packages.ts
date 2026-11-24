import { lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createConfigFileDocuments, createInstallationSecretCustody, openConfiguredSecretStore, openLocalIntegrityAuthority, openPreparedPackageInput, openSqliteApprovalStore,
  packageTargetIdentity, readSecretsConfig, resolveGitWorkTarget, selectWorkTarget, verifyPackageObject, writePreparedPackageList } from '#adapters/index.js';
import { NATIVE_NODE_DEPENDENCY_LAYOUT as layout } from '#domain/index.js';
import { capturePackageSecrets, changePackageAllowance, withPackageUse as usePackages,
  type PackageBinding, type PackageConsentCard, type PackageConsentRequest, type PackageKnownSecrets, type PackageSecretPort, type WorkerPackagePorts } from '#engine/index.js';
import { privateDirectory, privateFile, productResourcePath, withConfigWriteLock, type ConfigLoadOptions } from '#platform/index.js';
import { configuredApproval } from '#composition/core/approvals/index.js';
import { configPersonWitness, snapshotConfiguredConfig } from '#composition/core/config/index.js';
import { contextPolicySource, withLayoutPolicyWriteLock } from '#composition/core/policy/index.js';
import { loadConfiguredScopeContext, withScopeAudit } from '#composition/core/scoped-request/index.js';

type Context = Awaited<ReturnType<typeof loadConfiguredScopeContext>>;

function packageSecretPort(options: ConfigLoadOptions): PackageSecretPort {
  return {
    configuredStore: config => readSecretsConfig(config).store,
    open: config => openConfiguredSecretStore(config, options.env ?? process.env, options.platform ?? process.platform),
    exclusive(work) {
      const custody = createInstallationSecretCustody(options.env ?? process.env, options.platform ?? process.platform);
      return custody.exclusive(() => work(() => custody.selected()));
    },
  };
}

function preparedHost(context: Context, secrets: PackageSecretPort) {
  return { policy: () => contextPolicySource(context), captureSecrets: () => capturePackageSecrets(secrets, context.config) };
}

export function configuredWorkerPackagePorts(root: string, options: ConfigLoadOptions): WorkerPackagePorts<Context> {
  const secrets = packageSecretPort(options);
  return {
    loadScope: (scopeId, access) => loadConfiguredScopeContext(root, scopeId, { ...options, heal: false, force: true }, access),
    policySource: contextPolicySource,
    snapshotConfig: () => snapshotConfiguredConfig(root, options),
    async rowsArePrivate(context) {
      const path = context.layout.bootstrapConfigPath;
      return Boolean(await privateDirectory(dirname(path)) && privateFile(await lstat(path)));
    },
    configDocuments: () => createConfigFileDocuments(root, options),
    selectedTarget: context => selectWorkTarget(context.config.execution)?.id ?? null,
    async resolveTarget(context, canonicalProject) {
      const project = canonicalProject ? await realpath(resolve(root)) : root;
      const target = await resolveGitWorkTarget(project, context.config.execution, context.layout);
      return { project, workTarget: target.git.sourceRoot, id: target.id };
    },
    targetIdentity: packageTargetIdentity,
    platform: `${process.platform}-${process.arch}`,
    lockPartition(context, partition, work) {
      const directory = join(productResourcePath(context.installationLayout, 'audit'), 'package-allowance-locks');
      return withConfigWriteLock(join(directory, partition), work, context.config.configFile.writeLockTimeoutMs);
    },
    withAudit: withScopeAudit,
    lockPolicy: (context, work) => withLayoutPolicyWriteLock(context.layout, work),
    async withApprovals(context, createKey, work) {
      const { config } = context, integrity = await openLocalIntegrityAuthority(context.layout, config.approvals.keyFile, createKey);
      const journal = openSqliteApprovalStore(await context.path(), config.storage.sqlite, 'forbid');
      try { return await work(journal.store, integrity); } finally { journal.close(); }
    },
    witness: operation => configPersonWitness()(operation),
    decideApproval: input => configuredApproval(root, 'decide', input, options),
    secrets,
    prepare: (context, scopeId, pinnedCommit, known) =>
      openPreparedPackageInput(root, context, scopeId, layout, pinnedCommit, options, preparedHost(context, secrets), known),
    verifyObject: verifyPackageObject,
  };
}

export function configuredPackageList(root: string, context: Context, scopeId: string, options: ConfigLoadOptions, cachePath?: string) {
  return writePreparedPackageList(root, context, scopeId, layout, preparedHost(context, packageSecretPort(options)), cachePath);
}

export function changeConfiguredPackageAllowance(root: string, request: PackageConsentRequest, options: ConfigLoadOptions,
  confirm: (card: PackageConsentCard) => Promise<boolean>) {
  return changePackageAllowance(configuredWorkerPackagePorts(root, options), request, confirm);
}

export function withPackageUse<T>(root: string, context: Context, options: ConfigLoadOptions, bindings: readonly [PackageBinding, ...PackageBinding[]],
  action: 'admit' | 'open', useId: string, work: () => Promise<T>, prepare?: (fresh: Context, binding: PackageBinding, known: PackageKnownSecrets) => Promise<void>) {
  return usePackages(configuredWorkerPackagePorts(root, options), context, bindings, action, useId, work, prepare);
}
