import type { McpPanelRun } from './mcp-panel.js';
import type { ProjectIdentity } from '#domain/index.js';
import type { DescribeService, IdentityRead, InstallationIdentityRead, RunCommand, RunCancellationOutcome, RunQuery, RunView, SurfaceSnapshotAccess,
  TaskWorkerModel } from '#engine/index.js';
import type { ConfigLoadOptions, Locale, OutputSink, ProductLayout } from '#platform/index.js';
import type { ModelCommandContext } from '#surfaces/core/cli-models/index.js';
import type { MonitorCommandContext, WorkerTranscriptHandler } from '#surfaces/core/monitor/index.js';
import type { TerminalAdminContext } from '#surfaces/core/terminal-admin/index.js';
import type { ComposerHistoryPort } from '#surfaces/core/terminal-composer/index.js';
import type { SurfaceFollowEvent } from '#surfaces/core/terminal-kit/index.js';
import type { TerminalSessionStoreView } from '#surfaces/core/terminal/index.js';
import type { TerminalChatPlanHandler, TerminalChatStreamHandler, TerminalChatTurnHandler, TerminalMentionAttachHandler, TerminalMentionFindHandler,
  TerminalPermissionModeInspectHandler, TerminalPermissionModeSetHandler, TerminalScratchClearHandler, TerminalScratchInspectHandler } from './terminal-chat.js';

/** Same handlers as `deckent run` and `deckent run cancel`; the terminal's run card and `/cancel` use them through the ledger ports. */
export type RunQueryHandler = (root: string, query: RunQuery, options: ConfigLoadOptions) => Promise<Readonly<{ schemaVersion: 1; layout: ProductLayout; run: RunView | null;
  models?: readonly TaskWorkerModel[] }>>;
export type RunCancellationDeliveryHandler = (root: string, command: RunCommand, options: ConfigLoadOptions) => Promise<Readonly<{ schemaVersion: 1; layout: ProductLayout; delivery: Readonly<{ schemaVersion: 2; runId: string; scopeId: string; cancellationRequested: true; outcomes: readonly RunCancellationOutcome[] }> }>>;

export interface RuntimeServiceReadinessView {
  readonly mode: 'connected' | 'started'; readonly instanceId: string; readonly pid: number | null; readonly logPath: string | null;
  readonly shutdownAvailable: boolean; readonly build: { readonly sourceTreeSha256: string; readonly sourceCommit: string | null } | null;
  /** Restart-apply configuration fingerprint the service started with (undefined from an older service) and its idle stop period (null: never). */
  readonly configDigest?: string | undefined; readonly idleStopMs?: number | null;
}

/** What the config surface and the read-only management commands both read from a service describe. */
type ServiceDescription = Awaited<ReturnType<DescribeService>> & Awaited<ReturnType<NonNullable<TerminalAdminContext['describeRuntimeService']>>>;

/**
 * The slice of the host's command context the interactive terminal reads (TERMINAL-LAUNCH, design A); the CLI's command context extends it.
 * Commands that live in the CLI (`doctor`, `/mcp`, the cancellation text) reach the terminal as {@link TerminalLaunchPorts}, never as an import.
 */
/** T4 PROVIDER-CONNECT: one `/provider` kind as the host's adapter data gives it (this unit never imports the adapter). */
export type ProviderConnectKindView = Readonly<{ id: string; labelKey: string; available: boolean; endpointDefault: string | null; endpointEditable: boolean; keyRequired: boolean;
  secretName: string | null; probePath: string | null; endpointChoices: readonly Readonly<{ id: string; labelKey: string; url: string }>[];
  /** T4-B: the protocol family a connected model must speak (null: no model can be connected to this kind); `seeded`: its models come from its catalog seed. */
  connectFamily?: string | null; seeded?: boolean;
  /** Owner 2026-10-08: a remote address of this kind needs a declared price first (SPEND-SETTLEMENT); its model action is locked until then. */
  priceRequired?: boolean }>;
/** The free check's typed outcome (no body, no key). `outcome` is one of the adapter's `PROVIDER_PROBE_OUTCOMES`. */
export type ProviderConnectProbeView = Readonly<{ outcome: string; httpStatus: number | null; key: 'verified' | 'none' | 'unverified' }>;
/** What the host binds for `/provider`: the kinds, the endpoint rule and the free check (a refusal before any request is a typed error with `code`). */
export interface ProviderConnectHost {
  readonly kinds: readonly ProviderConnectKindView[];
  endpoint(text: string): Readonly<{ ok: true; base: string }> | Readonly<{ ok: false; reason: string }>;
  probe(input: Readonly<{ kind: string; endpoint: string | null; key: string | null }>, signal?: AbortSignal): Promise<ProviderConnectProbeView>;
  /** T4-B: the key's store name at an address (the generic row derives it from the host); the seed models of a seeded kind (exact ids, names). */
  secretName?(kind: string, endpoint: string | null): string | null;
  seedModels?(kind: string): Promise<readonly Readonly<{ nativeId: string; displayName: string }>[]>;
}
/** The installation secret store through the runtime service (SECRET-WRITE): the same handlers as `deckent secret` — names only, never values back. */
export type TerminalSecretNamesHandler = (root: string, options: ConfigLoadOptions) => Promise<Readonly<{ schemaVersion: 1; backend: string; names: readonly string[] }>>;
export type TerminalSecretChange = Readonly<{ schemaVersion: 1; scopeId: string; name: string; action: 'set' | 'delete'; backend: string; removed: boolean | null }>;
export type TerminalSecretSetHandler = (root: string, input: Readonly<{ schemaVersion: 1; scopeId: string; name: string; value: string }>, options: ConfigLoadOptions) => Promise<TerminalSecretChange>;
export type TerminalSecretDeleteHandler = (root: string, input: Readonly<{ schemaVersion: 1; scopeId: string; name: string }>, options: ConfigLoadOptions) => Promise<TerminalSecretChange>;

export interface TerminalLaunchContext extends MonitorCommandContext, Pick<ModelCommandContext, 'inspectModelCatalog' | 'inspectProviderSpendAccount' | 'inspectDeclaredModels'
  | 'inspectModelBinding' | 'inspectModelActivation' | 'connectModel'> {
  /** T4 `/provider`: the connect kinds and free check, and the secret store handlers (the key goes only to `setSecret`). */
  providerConnect?: ProviderConnectHost;
  listSecretNames?: TerminalSecretNamesHandler;
  setSecret?: TerminalSecretSetHandler;
  deleteSecret?: TerminalSecretDeleteHandler;
  loadInstallationIdentity?: (root: string, options: ConfigLoadOptions) => Promise<InstallationIdentityRead>;
  loadProjectIdentity?: (root: string, options: ConfigLoadOptions) => Promise<IdentityRead<ProjectIdentity>>;
  /** Managed interactive startup only; status and piped observation never call this write port. */
  ensureTerminalIdentity?: (root: string, scopeId: string, options: ConfigLoadOptions) => Promise<{ readonly installationId: string; readonly projectId: string }>;
  selfSourceProject?: (root: string) => Promise<boolean>;
  describeRuntimeService?: (root: string, options: ConfigLoadOptions) => Promise<ServiceDescription>;
  ensureRuntimeService?: (root: string, options: ConfigLoadOptions) => Promise<RuntimeServiceReadinessView>;
  restartRuntimeService?: (root: string, options: ConfigLoadOptions) => Promise<RuntimeServiceReadinessView>;
  openTerminalHistory?: (root: string, options: ConfigLoadOptions) => Promise<ComposerHistoryPort | null>;
  openTerminalSessions?: (root: string, options: ConfigLoadOptions) => Promise<TerminalSessionStoreView | null>;
  completeTerminalChat?: TerminalChatTurnHandler;
  streamTerminalChat?: TerminalChatStreamHandler;
  findTerminalMentions?: TerminalMentionFindHandler;
  attachTerminalMentions?: TerminalMentionAttachHandler;
  inspectPermissionMode?: TerminalPermissionModeInspectHandler;
  setPermissionMode?: TerminalPermissionModeSetHandler;
  inspectScratch?: TerminalScratchInspectHandler;
  clearScratch?: TerminalScratchClearHandler;
  describeTerminalChatPlan?: TerminalChatPlanHandler;
  inspectRun?: RunQueryHandler;
  deliverRunCancellation?: RunCancellationDeliveryHandler;
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
  /** `/doctor`: the host's kernel command (`doctor --lang <locale>`) over the launch context with the given sinks. */
  readonly runKernelCommand: (argv: readonly string[], overrides: { readonly root: string; readonly env: NodeJS.ProcessEnv; readonly stdout: OutputSink; readonly stderr: OutputSink }) => Promise<void>;
  /** `/mcp`: absent when the host wires no MCP command handler (the slash command is then not offered). */
  readonly mcpSlash?: (root: string, args: string, options: ConfigLoadOptions, locale: Locale) => Promise<readonly string[]>;
  /** The `/mcp` window (T3 L4): the host's registry command itself (`deckent mcp`'s handler), with the window's trust question as `ask`. */
  readonly runMcp?: McpPanelRun;
  readonly renderRunCancellation: RunCancellationRenderer;
}
