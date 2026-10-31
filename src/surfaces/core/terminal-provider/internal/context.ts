import type { ConfigLoadOptions } from '#platform/index.js';
import type { ModelCommandContext } from '#surfaces/core/cli-models/index.js';
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
  billing?: 'subscription' | 'local' | 'metered' }>;
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
}
/** The installation secret store through the runtime service (SECRET-WRITE): the same handlers as `deckent secret` — names only, never values back. */
export type TerminalSecretNamesHandler = (root: string, options: ConfigLoadOptions) => Promise<Readonly<{ schemaVersion: 1; backend: string; names: readonly string[] }>>;
export type TerminalSecretChange = Readonly<{ schemaVersion: 1; scopeId: string; name: string; action: 'set' | 'delete'; backend: string; removed: boolean | null }>;
export type ProviderSecretStepView = Readonly<{ state: 'ready' | 'stored' | 'granted' | 'refused' | 'admin' | 'skipped'; code?: string; path?: string }>;
export type ProviderCustodyView = ProviderSecretStepView & Readonly<{ backend: string | null }>;
export type TerminalSecretSetHandler = (root: string, input: Readonly<{ schemaVersion: 1; scopeId: string; name: string; value: string }>, options: ConfigLoadOptions) => Promise<TerminalSecretChange>;
export type TerminalSecretDeleteHandler = (root: string, input: Readonly<{ schemaVersion: 1; scopeId: string; name: string }>, options: ConfigLoadOptions) => Promise<TerminalSecretChange>;
export interface ProviderPanelHost extends Pick<ModelCommandContext, 'inspectModelCatalog' | 'inspectProviderSpendAccount' | 'inspectDeclaredModels' | 'connectModel' | 'siwc'> {
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
