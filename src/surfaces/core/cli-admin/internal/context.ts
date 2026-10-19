import type { ConfigLoadOptions } from '#platform/index.js';
import type { ServiceShutdownAdmissionResult, ShutdownCommand, ToolchainCurrencyReport } from '#engine/index.js';
import type { CliBaseContext } from '#surfaces/core/cli-kit/index.js';
import type { TerminalLaunchContext } from '#surfaces/core/cli-terminal/index.js';
import type { AuditRebaselineHandler, AuditVerifyHandler } from './audit.js';
import type { BackupHandler } from './backup.js';
import type { CodingProfilePreparationHandler, CodingTemplateHandler } from './coding.js';
import type { OperationEffectHandler, OperationInspectHandler } from './operation.js';
import type { PoolCapacityApplyHandler, PoolCapacityInspectHandler, PoolHoldApplyHandler, PoolHoldInspectHandler, QuotaReleaseHandler } from './pool.js';
import type { RuntimeServiceDescribeHandler, RuntimeServiceShutdownHandler, RuntimeServiceStartHandler } from './runtime.js';
import type { SecretDeleteHandler, SecretNamesHandler, SecretSetHandler, SecretStoreInspectHandler } from './secret.js';
import type { SecretStoreSwitchHandler, SecretStoresHandler } from './secret-store.js';
import type { ToolchainUpdateHandler } from './toolchains.js';

/** The host operations the administration commands use (pool, backup, secret, audit, runtime, toolchains, operation, coding);
 * the CLI's full command context satisfies it. */
export interface AdminCommandContext extends CliBaseContext, Pick<TerminalLaunchContext, 'restartRuntimeService'> {
  verifyAudit?: AuditVerifyHandler;
  rebaselineAudit?: AuditRebaselineHandler;
  executeBackup?: BackupHandler;
  executeOperation?: OperationEffectHandler;
  compensateOperation?: OperationEffectHandler;
  inspectOperation?: OperationInspectHandler;
  inspectToolchainCurrency?: (root: string, options: ConfigLoadOptions) => Promise<ToolchainCurrencyReport>;
  stopRuntimeService?: (root: string, options: ConfigLoadOptions) => Promise<{ readonly command: ShutdownCommand; readonly result: ServiceShutdownAdmissionResult }>;
  updateToolchains?: ToolchainUpdateHandler;
  prepareCodingProfile?: CodingProfilePreparationHandler;
  configureCodingTemplate?: CodingTemplateHandler;
  // SECRET-K1 (owner S1): the active secret backend and its state; doctor-only, never a hard failure of doctor. `secret list` names only.
  inspectSecretStore?: SecretStoreInspectHandler;
  listSecretNames?: SecretNamesHandler;
  // SECRET-WRITE: `secret set|delete` through the runtime service (the socket peer is the principal; the `secret` policy cell decides).
  setSecret?: SecretSetHandler;
  deleteSecret?: SecretDeleteHandler;
  // SECRET-STORE-SWITCH (v24): the stores for the picker and the governed switch through the runtime service (`secret`/`switch`).
  listSecretStores?: SecretStoresHandler;
  switchSecretStore?: SecretStoreSwitchHandler;
  // K5 typed pool hold: `pool hold|resume|status` (local application, no runtime service needed).
  applyPoolCapacity?: PoolCapacityApplyHandler;
  inspectPoolCapacity?: PoolCapacityInspectHandler;
  releaseQuota?: QuotaReleaseHandler;
  applyPoolHold?: PoolHoldApplyHandler;
  inspectPoolHold?: PoolHoldInspectHandler;
  startRuntimeService?: RuntimeServiceStartHandler;
  describeRuntimeService?: RuntimeServiceDescribeHandler;
  shutdownRuntimeService?: RuntimeServiceShutdownHandler;
}
