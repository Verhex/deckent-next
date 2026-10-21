import type { IdentityCommandContext } from '#surfaces/core/cli-identity/index.js';
import type { InstallationCommandContext } from '#surfaces/core/cli-installation/index.js';
import type { TerminalLaunchContext } from '#surfaces/core/cli-terminal/index.js';
import type { ModelCommandContext } from '#surfaces/core/cli-models/index.js';
import type { DecisionCommandContext } from '#surfaces/core/cli-decision/index.js';
import type { RunCommandContext } from '#surfaces/core/cli-run/index.js';
import type { TaskCommandContext, TaskIntegrationCheckHandler, TaskIntegrationPrepareHandler, TaskPatchHandler } from '#surfaces/core/cli-task/index.js';
import type { ApprovalCommandContext } from '#surfaces/core/cli-approval/index.js';
import type { AdminCommandContext, RuntimeServiceDescribeHandler, SecretDeleteHandler, SecretNamesHandler, SecretSetHandler } from '#surfaces/core/cli-admin/index.js';
import type { KernelCommandContext } from '#surfaces/core/cli-observe/index.js';
import type { McpCommandHandler } from './mcp.js';
import { lazyFunction } from '#surfaces/core/cli-kit/index.js';
/** doctor, paths and policy (COLDSTART: loaded on the first call; they reach the engine barrel). */
export const runKernelCommand = lazyFunction(() => import('#surfaces/core/cli-observe/index.js'), 'runKernelCommand');

export type { RuntimeServiceReadinessView } from '#surfaces/core/cli-terminal/index.js';
export type { InstallationBindingReport, ShellRealmDoctorView } from '#surfaces/core/doctor/index.js';
export type { InferenceMetricsReading } from '#surfaces/core/cli-models/index.js';

/** Every host operation a CLI command may use; each command unit's narrower context is part of it. */
export type { RunLifecycleHandler } from '#surfaces/core/cli-terminal/index.js';
/** The terminal's slice (TERMINAL-LAUNCH) carries the monitor and config command contexts. */
export interface CommandContext extends InstallationCommandContext, IdentityCommandContext, ModelCommandContext, DecisionCommandContext, TerminalLaunchContext,
  RunCommandContext, TaskCommandContext, ApprovalCommandContext, AdminCommandContext, KernelCommandContext {
  runMcpCommand?: McpCommandHandler;
  initialize?: () => void;
  /** COLDSTART: the host's operations, loaded only when a command or the terminal runs (never for help, `--version` or an unknown command). */
  loadHost?: () => Promise<CommandContext>;
  // The terminal launch context names these with its own narrower types; the CLI commands' types win here, as before the unit split.
  checkWorkspaceIntegration?: TaskIntegrationCheckHandler;
  prepareWorkspaceIntegration?: TaskIntegrationPrepareHandler;
  previewWorkspacePatch?: TaskPatchHandler;
  renderUnifiedDiff?: (path: string, before: string | null, after: string | null) => string;
  describeRuntimeService?: RuntimeServiceDescribeHandler;
  listSecretNames?: SecretNamesHandler;
  setSecret?: SecretSetHandler;
  deleteSecret?: SecretDeleteHandler;
}
