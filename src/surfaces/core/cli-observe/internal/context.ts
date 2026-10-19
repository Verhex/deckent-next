import type { ConfigLoadOptions } from '#platform/index.js';
import type { ModelInvocationDeliveryFinding } from '#engine/index.js';
import type { CliBaseContext } from '#surfaces/core/cli-kit/index.js';
import type { InstallationBindingReport, InstallationStartabilityView, RecoveryFilesDoctorView, ShellRealmDoctorView } from '#surfaces/core/doctor/index.js';
import type { AdminCommandContext } from '#surfaces/core/cli-admin/index.js';
import type { ApprovalCommandContext } from '#surfaces/core/cli-approval/index.js';

/** The host operations the kernel commands (doctor, paths, policy vocabulary) use; the CLI's full command context satisfies it. */
export interface KernelCommandContext extends CliBaseContext, Pick<AdminCommandContext, 'verifyAudit' | 'inspectToolchainCurrency' | 'inspectSecretStore' | 'describeRuntimeService'
  | 'inspectPoolCapacity' | 'inspectPoolHold'>, Pick<ApprovalCommandContext, 'inspectPolicyAdministration'> {
  inspectInstallationStartability?: (root: string, options: ConfigLoadOptions) => Promise<InstallationStartabilityView>;
  inspectPolicyTemplate?: (root: string, options: ConfigLoadOptions) => Promise<{ readonly id: string; readonly version: number } | null>;
  // Doctor-only, read-soft, network-free (SESSION-RESULT-LIMIT-2026-09-28): [] when unwired or nothing is unfit.
  assessModelInvocationDelivery?: (root: string, options: ConfigLoadOptions) => Promise<readonly ModelInvocationDeliveryFinding[]>;
  // S1 D4: files an interrupted backup restore left behind; doctor-only, read-soft (null when unwired or unreadable).
  inspectRecoveryFiles?: (root: string, options: ConfigLoadOptions) => Promise<RecoveryFilesDoctorView>;
  // REALM-NOTICE: the shell realm a call here gets and every sandbox provider passed over (read-only measurement); doctor-only.
  inspectShellRealm?: (root: string, options: ConfigLoadOptions) => Promise<ShellRealmDoctorView>;
  // WORKER-AUTO-REFRESH: the worker image refresh status (updating / current / failed with a typed reason); doctor-only, local file read, null when unwired or never run.
  inspectToolchainRefresh?: (root: string, options: ConfigLoadOptions) => Promise<{ readonly status: string; readonly reason: string | null; readonly imageVersion: string | null } | null>;
  // Doctor-only, read-soft: whether the installation identity can be bound to this machine (relocation/copy detection); null when unwired or unreadable.
  inspectInstallationBinding?: (root: string, options: ConfigLoadOptions) => Promise<InstallationBindingReport | null>;
}
