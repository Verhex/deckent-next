import type { ConfigLoadOptions } from '#platform/index.js';
import type { ModelCatalogInspection, ModelInvocationDeliveryFinding, ModelRoleInspection, ModelRoleQuery, RecoveryModeState } from '#engine/index.js';
import type { ModelCatalogQuery } from '#domain/index.js';
import type { CliBaseContext } from '#surfaces/core/cli-kit/index.js';
import type { DoctorCheckFacts, ExecutionEnvironmentDoctorView, InstallationBindingReport, InstallationStartabilityView, RecoveryFilesDoctorView, ShellRealmDoctorView } from '#surfaces/core/doctor/index.js';
import type { AdminCommandContext } from '#surfaces/core/cli-admin/index.js';
import type { ApprovalCommandContext } from '#surfaces/core/cli-approval/index.js';

/** The host operations the kernel commands (doctor, paths, policy vocabulary) use; the CLI's full command context satisfies it. */
export interface KernelCommandContext extends CliBaseContext, Pick<AdminCommandContext, 'verifyAudit' | 'inspectToolchainCurrency' | 'inspectSecretStore' | 'inspectSecretInventory' | 'describeRuntimeService'
  | 'inspectPoolCapacity' | 'inspectPoolHold' | 'listSecretNames' | 'updateToolchains' | 'inspectAdminPaths'>, Pick<ApprovalCommandContext, 'inspectPolicyAdministration'> {
  // C-DOCTOR: the same read-only catalog listing as `deckent models list` (model retirement rows); read-soft, never a runtime-service view.
  inspectModelCatalog?: (root: string, query: ModelCatalogQuery, options: ConfigLoadOptions) => Promise<ModelCatalogInspection>;
  // M2: the same read view as `deckent models roles` (catalog models with no tier/role row: "new model: role pending"); read-soft.
  inspectModelRoles?: (root: string, query: ModelRoleQuery, options: ConfigLoadOptions) => Promise<ModelRoleInspection>;
  /** S3-3 doctor line: the scope's subscription Brain logins from the profiles section and their last preflight records (read-soft, no spawn). */
  readHeadlessLogins?: (profiles: unknown, scopeId: string) => Promise<NonNullable<DoctorCheckFacts['headlessLogins']>>;
  inspectInstallationStartability?: (root: string, options: ConfigLoadOptions) => Promise<InstallationStartabilityView>;
  inspectPolicyTemplate?: (root: string, options: ConfigLoadOptions) => Promise<{ readonly id: string; readonly version: number } | null>;
  // Doctor-only, read-soft, network-free (SESSION-RESULT-LIMIT-2026-09-28): [] when unwired or nothing is unfit.
  assessModelInvocationDelivery?: (root: string, options: ConfigLoadOptions) => Promise<readonly ModelInvocationDeliveryFinding[]>;
  // S1 D4: files an interrupted backup restore left behind; doctor-only, read-soft (null when unwired or unreadable).
  inspectRecoveryFiles?: (root: string, options: ConfigLoadOptions) => Promise<RecoveryFilesDoctorView>;
  /** S6R-6: the protected Nervous/recovery modes and the owner's standing continuation grant in a scope (doctor's recovery row). */
  inspectRecoveryMode?: (root: string, input: { schemaVersion: 1; scopeId: string }, options: ConfigLoadOptions) => Promise<RecoveryModeState>;
  // REALM-NOTICE: the shell realm a call here gets and every sandbox provider passed over (read-only measurement); doctor-only.
  inspectShellRealm?: (root: string, options: ConfigLoadOptions) => Promise<ShellRealmDoctorView>;
  // WORKER-AUTO-REFRESH: the worker image refresh status (updating / current / failed with a typed reason); doctor-only, local file read, null when unwired or never run.
  inspectToolchainRefresh?: (root: string, options: ConfigLoadOptions) => Promise<{ readonly status: string; readonly reason: string | null; readonly imageVersion: string | null } | null>;
  // Doctor-only, read-soft: whether the installation identity can be bound to this machine (relocation/copy detection); null when unwired or unreadable.
  inspectInstallationBinding?: (root: string, options: ConfigLoadOptions) => Promise<InstallationBindingReport | null>;
  // PRE-34: the execution environment (Docker) as `deckent init` detects and decides it; doctor-only, read-only, bounded by the detection deadline.
  inspectExecutionEnvironment?: (env: NodeJS.ProcessEnv) => Promise<ExecutionEnvironmentDoctorView>;
  /** BR1 1c: whether this Docker's daemon has the image (read-only `image inspect`, never a pull or a container). */
  inspectWorkerImage?: (input: Readonly<{ executable: string; imageId: string; timeoutMs?: number; outputBytes?: number }>) => Promise<'present' | 'missing' | 'unknown'>;
}
