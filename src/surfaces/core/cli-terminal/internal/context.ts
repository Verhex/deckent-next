import type { ProviderPanelHost } from '#surfaces/core/terminal-provider/index.js';
export type { ProviderConnectHost, ProviderConnectKindView, ProviderConnectProbeView, TerminalSecretNamesHandler, TerminalSecretChange, TerminalSecretSetHandler, TerminalSecretDeleteHandler, ProviderSecretStepView, ProviderCustodyView } from '#surfaces/core/terminal-provider/index.js';
import type { HubCommandContext } from '#surfaces/core/cli-hub/index.js';
import type { PermissionMode } from '#domain/index.js';
import type { ProjectInstructionPort } from '#engine/index.js';
import type { BrainPlanCommand, BrainPlanObserver } from '#domain/index.js';
import type { RunPlanningResult } from '#engine/index.js';
import type { McpPanelRun } from './mcp-panel.js';
import type { TerminalSecretGrantHandlers } from './secret-grant-card.js';
import type { ModelReference, ProjectIdentity } from '#domain/index.js';
import type { DeliveryPortHost } from '#surfaces/core/delivery-port/index.js';
import type { DescribeService, IdentityRead, InstallationIdentityRead, RunCommand, RunCancellationOutcome, RunQuery, RunView, SurfaceSnapshotAccess,
  TaskWorkerModel } from '#engine/index.js';
import type { ConfigLoadOptions, Locale, OutputSink, ProductLayout } from '#platform/index.js';
import type { ModelCommandContext } from '#surfaces/core/cli-models/index.js';
import type { AutonomyShadowReader } from '#surfaces/core/delivery-summary/index.js';
import type { MonitorCommandContext, WorkerTranscriptHandler } from '#surfaces/core/monitor/index.js';
import type { TerminalAdminContext } from '#surfaces/core/terminal-admin/index.js';
import type { ComposerHistoryPort } from '#surfaces/core/terminal-composer/index.js';
import type { SurfaceFollowEvent } from '#surfaces/core/terminal-kit/index.js';
import type { TerminalSessionStoreView, WorklineProps } from '#surfaces/core/terminal/index.js';
import type { TerminalChatPlanHandler, TerminalChatStreamHandler, TerminalChatTurnHandler, TerminalMentionAttachHandler, TerminalMentionFindHandler,
  TerminalPermissionModeInspectHandler, TerminalPermissionModeSetHandler, TerminalScratchClearHandler, TerminalScratchInspectHandler } from './terminal-chat.js';
/** Same handlers as `deckent run` and `deckent run cancel`; the terminal's run card and `/cancel` use them through the ledger ports. */
export type RunQueryHandler = (root: string, query: RunQuery, options: ConfigLoadOptions) => Promise<Readonly<{ schemaVersion: 1; layout: ProductLayout; run: RunView | null;
  models?: readonly TaskWorkerModel[] }>>;
/** Same handler as `deckent run hold|resume|close` (the CLI's in-process lifecycle application); the terminal's Runs window keys use it through the ledger ports. */
export type RunLifecycleHandler = (root: string, input: import('#engine/index.js').RunLifecycleCommand, options: ConfigLoadOptions) => Promise<Readonly<{ schemaVersion: 1; layout: ProductLayout;
  lifecycle: Readonly<{ schemaVersion: 1; commandId: string; run: RunView }> }> | null>;
export type RunCancellationDeliveryHandler = (root: string, command: RunCommand, options: ConfigLoadOptions) => Promise<Readonly<{ schemaVersion: 1; layout: ProductLayout; delivery: Readonly<{ schemaVersion: 2; runId: string; scopeId: string; cancellationRequested: true; outcomes: readonly RunCancellationOutcome[] }> }>>;
export interface RuntimeServiceReadinessView {
  readonly mode: 'connected' | 'started'; readonly instanceId: string; readonly pid: number | null; readonly logPath: string | null;
  readonly shutdownAvailable: boolean; readonly build: { readonly sourceTreeSha256: string; readonly sourceCommit: string | null } | null;
  /** Restart-apply configuration fingerprint the service started with (undefined from an older service) and its idle stop period (null: never). */
  readonly configDigest?: string | undefined; readonly idleStopMs?: number | null;
}
/** What the config surface and the read-only management commands both read from a service describe. */
type ServiceDescription = Awaited<ReturnType<DescribeService>> & Awaited<ReturnType<NonNullable<TerminalAdminContext['describeRuntimeService']>>>;
/** The engine's `ProfileCachePlan` as this unit reads it (no engine model-activation import here). */
export type TerminalProfileCachePlan = Readonly<{ models: readonly Readonly<{ reference: ModelReference; ttl: string; modelId: string; writeRatio: number; readRatio: number }>[];
  writes: readonly Readonly<{ layer: 'global' | 'project'; value: Record<string, unknown> }>[]; shared: readonly ModelReference[] }>;
export type TerminalProfileProtocolPlan = Readonly<{ models: readonly Readonly<{ reference: ModelReference;
  detail: Readonly<{ modelId: string; from: string; to: string; protocol: string }> }>[];
  writes: readonly Readonly<{ layer: 'global' | 'project'; value: Record<string, unknown>; expect: string | null }>[]; shared: readonly ModelReference[] }>;
/**
 * The slice of the host's command context the interactive terminal reads (TERMINAL-LAUNCH, design A); the CLI's command context extends it.
 * Commands that live in the CLI (`doctor`, `/mcp`, the cancellation text) reach the terminal as {@link TerminalLaunchPorts}, never as an import.
 * The delivery window's handlers are {@link DeliveryPortHost} (KG9 F3).
 */
export interface TerminalLaunchContext extends ProviderPanelHost, MonitorCommandContext, HubCommandContext, DeliveryPortHost,
  Pick<ModelCommandContext, 'inspectModelRoles' | 'inspectModelBinding' | 'inspectModelActivation' | 'manageProviderSpend'> {
  /** BeUser DR3-02: the configured pool's hold (`deckent pool status`), read for the /do card. */
  inspectBeuserMonitor?: (options: ConfigLoadOptions) => Promise<import('#surfaces/core/terminal-beuser/index.js').BeuserMonitorView | null>;
  inspectPoolHold?: (root: string, query: { schemaVersion: 1; scopeId: string; poolId?: string | undefined }, options: ConfigLoadOptions) => Promise<import('#engine/index.js').PoolHoldView>;
  openOwnerBaselineInstallation?: (root: string, scopeId: string, input: { readonly families: readonly string[]; readonly apply: boolean; readonly person?: { readonly issuer: string; readonly subject: string }; readonly expect?: string }) => Promise<import('#engine/index.js').InstallerOwnerBaselineResult>;
  admitModelActivation?: import('#surfaces/core/cli-models/index.js').ModelActivationAdmissionHandler;
  /** R9b (owner D3): the models the Brain role may use in the scope today (tier or a current exception), each with its activation; `/model` marks them. */
  inspectBrainModels?: (root: string, scopeId: string, options: ConfigLoadOptions) => Promise<Readonly<{ models: readonly import('#domain/index.js').RoleModelRow[] }>>;
  openOnboarding?: (root: string, scopeId: string, folder: string, options: ConfigLoadOptions) => Promise<import('#surfaces/core/terminal-onboarding/index.js').OnboardingPort>;
  /** OTONOM-TESLIM shadow (lane B1 store): list and inspect only, never a consent card; absent = no shadow column or line. */
  readAutonomyShadow?: AutonomyShadowReader;
  /** `observe` (f3, owner Q-H4): the caller shows planning progress (a quota wait); absent: a quota refusal is the typed refusal at once. */
  readonly planRun?: (root: string, command: BrainPlanCommand, options: ConfigLoadOptions, signal?: AbortSignal, observe?: BrainPlanObserver) => Promise<RunPlanningResult>;
  mcpCapabilities?: import('#surfaces/core/work-labels/index.js').McpCapabilityHandlers;
  delegations?: import('#surfaces/core/work-labels/index.js').DelegationHandlers;
  /** alpha.64 (owner S6): `/policy`'s AI proposals row turns the v20 rules on (`--apply --only ai-proposals`) and off (`--rollback`) through this governed upgrade. */
  upgradePolicyTemplate?: import('./policy-panel.js').PolicyTemplateUpgradePort;
  openProjectInstructions?: (root: string, options: ConfigLoadOptions) => Promise<ProjectInstructionPort>;
  /** CACHE-SLICE1: the scope's existing profiles offered the 5-minute prompt cache, and the per-layer profile documents that switch it on (read only). */
  planProfileCache?: (root: string, scopeId: string, options: ConfigLoadOptions) => Promise<TerminalProfileCachePlan>;
  inspectModelReadiness?: (root: string, scopeId: string, reference: ModelReference, options: ConfigLoadOptions, reasoning?: 'off') => Promise<unknown>;
  prepareModelSwitch?: (root: string, scopeId: string, reference: ModelReference, options: ConfigLoadOptions, reasoning?: 'off') => Promise<void>;
  planProfileProtocol?: (root: string, scopeId: string, options: ConfigLoadOptions) => Promise<TerminalProfileProtocolPlan>;
  openProviderWorkspaces?: (root: string, scopeId: string, options: ConfigLoadOptions) => Promise<{
    profiles: readonly Readonly<{ id: string; reference: ModelReference; workspaceId: string | null }>[];
    list(id: string): Promise<readonly Readonly<{ id: string; name: string }>[] >;
    plan(id: string, workspaceId: string): Promise<{ shared: readonly ModelReference[]; writes: readonly Readonly<{ layer: 'global' | 'project'; value: Record<string, unknown>; expect: string | null }>[] }>;
  }>;
  loadInstallationIdentity?: (root: string, options: ConfigLoadOptions) => Promise<InstallationIdentityRead>;
  loadProjectIdentity?: (root: string, options: ConfigLoadOptions) => Promise<IdentityRead<ProjectIdentity>>;
  /** Managed interactive startup only; status and piped observation never call this write port. */
  ensureTerminalIdentity?: (root: string, scopeId: string, options: ConfigLoadOptions) => Promise<{ readonly installationId: string; readonly projectId: string }>;
  selfSourceProject?: (root: string) => Promise<boolean>;
  describeRuntimeService?: (root: string, options: ConfigLoadOptions) => Promise<ServiceDescription>;
  ensureRuntimeService?: (root: string, options: ConfigLoadOptions) => Promise<RuntimeServiceReadinessView>;
  restartRuntimeService?: (root: string, options: ConfigLoadOptions) => Promise<RuntimeServiceReadinessView>; runningImageBuild?: (root: string, options: ConfigLoadOptions) => Promise<boolean>; localRunOffer?: (root: string, scopeId: string, options: ConfigLoadOptions, code?: unknown) => Promise<boolean>; workingTreeChanges?: (root: string, options: ConfigLoadOptions) => Promise<Readonly<{ state: string; files: ReadonlyMap<string, string> }>>; // D-01: a worker image build runs in the service
  openTerminalHistory?: (root: string, options: ConfigLoadOptions) => Promise<ComposerHistoryPort | null>;
  openTerminalSessions?: (root: string, options: ConfigLoadOptions, folder?: string) => Promise<TerminalSessionStoreView | null>; /** alpha.60 C: the launch shell drawn before the host loaded; the Workline takes its host, draft and sent lines. */ terminalShell?: import('#surfaces/core/terminal-host/index.js').TerminalShell;
  /** T4 (Ctrl+G): the person's `$VISUAL`/`$EDITOR` behind the composition's adapter (temporary 0600 file, bounded read-back). */
  externalEditor?: WorklineProps['externalEditor'];
  completeTerminalChat?: TerminalChatTurnHandler;
  streamTerminalChat?: TerminalChatStreamHandler;
  /** PRE-8 first-use card (streamed turns): the composition's offer decision and the governed `secret grant` (source `card`). */
  secretGrantCard?: TerminalSecretGrantHandlers;
  findTerminalMentions?: TerminalMentionFindHandler;
  attachTerminalMentions?: TerminalMentionAttachHandler;
  /** CLI host custody only; the callback displays the exact PRE-9 preview, no wire authority. */
  openOwnPermissionMode?: (root: string, input: { scopeId: string; mode: Exclude<PermissionMode, 'standart'>;
    confirm: (preview: import('#engine/index.js').InstallerPermissionModesResult) => Promise<boolean>; signal?: AbortSignal }, options: ConfigLoadOptions) => Promise<boolean>;
  inspectPermissionMode?: TerminalPermissionModeInspectHandler;
  setPermissionMode?: TerminalPermissionModeSetHandler;
  inspectScratch?: TerminalScratchInspectHandler;
  clearScratch?: TerminalScratchClearHandler;
  describeTerminalChatPlan?: TerminalChatPlanHandler;
  inspectRun?: RunQueryHandler;
  deliverRunCancellation?: RunCancellationDeliveryHandler;
  applyRunLifecycle?: RunLifecycleHandler;
  inspectWorkerTranscript?: WorkerTranscriptHandler;
  listApprovals?: (input: unknown) => Promise<unknown>;
  decideApproval?: (input: unknown) => Promise<unknown>;
  clearSessionStanding?: (input: { schemaVersion: 1; scopeId: string; sessionId: string }) => Promise<unknown>;
  /** Approval, run and worker publications already written by the runtime service. */
  inspectSurfaceAccess?: (root: string, scopeId: string, options: ConfigLoadOptions) => Promise<SurfaceSnapshotAccess | null>;
  inspectSurfaceRunIds?: (root: string, scopeId: string, options: ConfigLoadOptions) => Promise<readonly string[]>;
  followSurfaceEvents?: (root: string, scopeId: string, options: ConfigLoadOptions, signal: AbortSignal) => AsyncIterable<SurfaceFollowEvent>;
}
/** Human rendering of a typed cancellation delivery (the CLI's `run cancel` text, shared by the terminal `/cancel` card). */
export type RunCancellationRenderer = (data: Awaited<ReturnType<RunCancellationDeliveryHandler>>, commandId: string, scopeId: string, runId: string, locale: Locale) => string;
/** The host commands the terminal uses; the CLI binds them to its own command context (this unit never imports the CLI). */
export interface TerminalLaunchPorts {
  readonly foregroundSetup?: (root: string, stage: import('#engine/index.js').SetupStage, scopeId: string, locale: Locale) => Promise<Readonly<{ status: string; code?: string }>>;
  /** `/doctor`: the host's kernel command (`doctor --lang <locale>`) over the launch context with the given sinks. */
  readonly runKernelCommand: (argv: readonly string[], overrides: { readonly root: string; readonly env: NodeJS.ProcessEnv; readonly stdout: OutputSink; readonly stderr: OutputSink }) => Promise<void>;
  /** `/mcp`: absent when the host wires no MCP command handler (the slash command is then not offered). */
  readonly mcpSlash?: (root: string, args: string, options: ConfigLoadOptions, locale: Locale) => Promise<readonly string[]>;
  /** The `/mcp` window (T3 L4): the host's registry command itself (`deckent mcp`'s handler), with the window's trust question as `ask`. */
  readonly runMcp?: McpPanelRun;
  readonly renderRunCancellation: RunCancellationRenderer;
}
