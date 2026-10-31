import type { ConfigLoadOptions } from '#platform/index.js';
import type { ModelCommandContext } from '#surfaces/core/cli-models/index.js';
import type { PanelLine, ProviderModelOutcome, ProviderPanelPort } from '#surfaces/core/terminal-panels/index.js';
/** T4 PROVIDER-CONNECT: one `/provider` kind as the host's adapter data gives it (this unit never imports the adapter). */
export type ProviderConnectKindView = Readonly<{ id: string; labelKey: string; available: boolean; endpointDefault: string | null; endpointEditable: boolean; keyRequired: boolean;
  catalogProviderId?: string | null;
  secretName: string | null; probePath: string | null; endpointChoices: readonly Readonly<{ id: string; labelKey: string; url: string }>[];
  /** T4-B: the protocol family a connected model must speak (null: no model can be connected to this kind); `seeded`: its models come from its catalog seed. */
  pull?: 'available' | 'pick';
  connectFamily?: string | null; seeded?: boolean;
  /** Owner W5: remote models require a verified published price; the endpoint-selected model row shows the refusal. */
  priceRequired?: boolean;
  /** İ-12: the registry billing class (kinds arrive no-spend first: subscription, local, then metered). */
  billing?: 'subscription' | 'local' | 'metered';
  /** PV: a CLI subscription that signs in with its own CLI (`models login`) and runs only inside the isolation realm. */
  headlessLogin?: boolean }>;
/** The free check's typed outcome (no body, no key). `outcome` is one of the adapter's `PROVIDER_PROBE_OUTCOMES`. */
export type ProviderConnectProbeView = Readonly<{ outcome: string; httpStatus: number | null; key: 'verified' | 'none' | 'unverified'; workspaceRequired?: true; cause?: string }>;
/** What the host binds for `/provider`: the kinds, the endpoint rule and the free check (a refusal before any request is a typed error with `code`). */
export interface ProviderConnectHost {
  readonly kinds: readonly ProviderConnectKindView[];
  endpoint(text: string): Readonly<{ ok: true; base: string }> | Readonly<{ ok: false; reason: string }>;
  probe(input: Readonly<{ kind: string; endpoint: string | null; key: string | null }>, signal?: AbortSignal): Promise<ProviderConnectProbeView>;
  /** T4-B: the key's store name at an address (the generic row derives it from the host); the seed models of a seeded kind (exact ids, names). */
  /** Key names an earlier release stored that no row uses any more, and the row to store the key under instead (registry data). */
  readonly legacyKeys?: readonly Readonly<{ secretName: string; moveTo: string }>[];
  workspaces?(root: string, scopeId: string, kind: string, endpoint: string | null, options: ConfigLoadOptions): Promise<readonly Readonly<{ id: string; name: string }>[]>;
  secretName?(kind: string, endpoint: string | null): string | null;
  seedModels?(kind: string): Promise<readonly Readonly<{ nativeId: string; displayName: string; priced?: boolean }>[]>;
  /** Seedless endpoint discovery after address selection; the same configured read used by models.connect. */
  discoverModels?(root: string, scopeId: string, kind: string, endpoint: string | null, options: ConfigLoadOptions):
    Promise<readonly Readonly<{ nativeId: string; displayName: string; priced: boolean }>[]>;
  /** PV 2a: the typed refusal a CLI subscription meets on this host (no usable isolation), or null when it can run. */
  isolationRefusal?(options: ConfigLoadOptions): Promise<Error | null>;
  /** PV 3: after the person check, the Brain's own login dir of a CLI subscription. */
  loginDir?(connection: string, options: ConfigLoadOptions): Promise<Readonly<{ owned: string }>>;
  /** PV 3: the CLI's own sign-in (`models login`, inherited stdio); the caller hands the terminal over around it. */
  login?(command: Readonly<{ connection: string; configDir?: string }>, options: ConfigLoadOptions): Promise<import('#surfaces/core/cli-models/index.js').HeadlessLoginView | null>;
}
/** The installation secret store through the runtime service (SECRET-WRITE): the same handlers as `deckent secret` — names only, never values back. */
export type TerminalSecretNamesHandler = (root: string, options: ConfigLoadOptions) => Promise<Readonly<{ schemaVersion: 1; backend: string; names: readonly string[] }>>;
export type TerminalSecretChange = Readonly<{ schemaVersion: 1; scopeId: string; name: string; action: 'set' | 'delete'; backend: string; removed: boolean | null }>;
export type ProviderSecretStepView = Readonly<{ state: 'ready' | 'stored' | 'granted' | 'refused' | 'admin' | 'skipped'; code?: string; path?: string }>;
export type ProviderCustodyView = ProviderSecretStepView & Readonly<{ backend: string | null }>;
export type TerminalSecretSetHandler = (root: string, input: Readonly<{ schemaVersion: 1; scopeId: string; name: string; value: string }>, options: ConfigLoadOptions) => Promise<TerminalSecretChange>;
export type TerminalSecretDeleteHandler = (root: string, input: Readonly<{ schemaVersion: 1; scopeId: string; name: string }>, options: ConfigLoadOptions) => Promise<TerminalSecretChange>;
/** Display-only policy facts. No config writer or principal resolver crosses this port. */
export type ProviderDelegationPermission = Readonly<{ layers: readonly ('global' | 'project')[]; decisions: readonly Readonly<{
  layer: 'global' | 'project'; decision: 'allow' | 'require-approval' | 'deny' | 'refused'; ruleId: string | null }>[] }>;
export interface ProviderPanelHost extends Pick<ModelCommandContext, 'inspectModelCatalog' | 'inspectProviderSpendAccount' | 'inspectDeclaredModels' | 'connectModel' | 'siwc'> {
  inspectDelegationPermission?: (root: string, scopeId: string, options: ConfigLoadOptions) => Promise<ProviderDelegationPermission | null>;
  providerConnect?: ProviderConnectHost;
  inspectInvocableModels?: (root: string, scopeId: string, options: ConfigLoadOptions) => Promise<import('#engine/index.js').InvocableModels>;
  listSecretNames?: TerminalSecretNamesHandler;
  setSecret?: TerminalSecretSetHandler;
  /** U1: custody is checked before key entry; the same governed connection keeps partial key/grant results. */
  prepareMainSecret?: (root: string, scopeId: string, options: ConfigLoadOptions) => Promise<ProviderCustodyView>;
  connectProviderSecret?: (root: string, input: Readonly<{ scopeId: string; name: string; value: string; grant: boolean }>, options: ConfigLoadOptions) => Promise<Readonly<{
    name: string; backend: string | null; custody: ProviderSecretStepView; key: ProviderSecretStepView; grant: ProviderSecretStepView }>>;
  deleteSecret?: TerminalSecretDeleteHandler;
}
/** PV: who besides the person may use a CLI subscription login (S10: never MCP). */
export type ProviderDelegateClass = 'ai' | 'system';
export type ProviderSubscriptionOutcome = ProviderModelOutcome & Readonly<{ delegationBlocked: string | null }> & (Readonly<{ state: 'applied'; delegate: readonly ProviderDelegateClass[] }>
  | Readonly<{ state: 'not-applied' | 'approval-pending' | 'applied-unverified'; delegate: null }>);
/**
 * PV 3 (owner S10): `/provider` signs a CLI subscription in and connects it — the login dir (the Brain's own by default), the CLI's own sign-in
 * on this terminal (the window hands the terminal over), the governed connect, then the person's delegated-use card. 2a: the refusal card of a
 * row this host cannot run, listing the rows that can.
 */
export interface ProviderSubscriptionPort {
  /** The rows that sign in with their CLI. */
  readonly kinds: readonly string[];
  readonly words: Readonly<Record<'action' | 'dirTitle' | 'dirOwned' | 'dirOther' | 'otherTitle' | 'otherHint' | 'otherAbsolute' | 'banner' | 'retryKeys' | 'consentTitle'
    | 'consentNow' | 'consentConfirm' | 'configPolicy' | 'onlyYou' | 'youAnd' | 'system' | 'ai' | 'mcp' | 'mcpBlocked' | 'question' | 'questionKeys', string>>;
  refusal(kind: string, usable: readonly string[]): Readonly<{ title: string; lines: readonly PanelLine[] }>;
  /** The person check, then what the sign-in will do and its shell twin; the Brain's own dir (null: refused, with its typed reason). */
  prepare(kind: string): Promise<Readonly<{ owned: string; lines: readonly PanelLine[] }> | Readonly<{ owned: null; title: string; lines: readonly PanelLine[] }>>;
  /** The CLI's own sign-in (null dir: the Brain's own); `refused`: nothing started (person check, isolation, a missing CLI). */
  login(kind: string, configDir: string | null): Promise<Readonly<{ signedIn: boolean; refused: boolean; title: string; lines: readonly PanelLine[] }>>;
  /** The governed connect; `delegate` absent keeps the earlier choice. `delegate` in the outcome: who may use the login now. */
  connect(kind: string, configDir: string | null, delegate?: readonly ProviderDelegateClass[]): Promise<ProviderSubscriptionOutcome>;
}
export type ProviderWindowPort = ProviderPanelPort & { readonly subscription?: ProviderSubscriptionPort };
