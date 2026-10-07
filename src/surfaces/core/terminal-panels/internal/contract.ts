import type { PermissionModeView } from '#domain/index.js';
import type { PermissionModeStop } from '#surfaces/core/terminal-render/index.js';
import type { PickerLabels } from '#surfaces/core/terminal-picker/index.js';

/**
 * T3 L4 PANELS: the ports and words of the interactive `/mode`, `/config` and `/mcp` windows (T4: `/model` and `/provider`). This unit only presents and collects a choice;
 * every read, write, policy decision and trust record stays behind the port the trusted composition binds (the same paths as the text
 * commands and `deckent config|mcp`). All words come in already localized; nothing here calls the catalog.
 */
export type PanelKind = 'mode' | 'config' | 'mcp' | 'model' | 'provider';
export type PanelNotice = Readonly<{ level: 'info' | 'warning' | 'error'; text: string }>;
/** A labelled body row of a panel window (detail views, trust questions). Values from a producer go through the decision projection. */
export type PanelLine = Readonly<{ label: string; text: string; tone?: 'warning' | 'muted' }>;

/** `/mode`: the person's permission mode through the runtime service (the same port and audit as `/mode <mode>` and Shift+Tab). */
export interface ModePanelPort {
  inspect(): Promise<PermissionModeView>;
  /** The stop this session runs in now (full access is the session's own), or null when unknown. */
  current(): PermissionModeStop | null;
  /** Steps the session to `stop` through the service; the caller reports the outcome (notice lines) itself. */
  select(stop: PermissionModeStop): Promise<void>;
}
export interface ModePanelLabels {
  readonly title: string; readonly hints: string;
  readonly stops: Readonly<Record<PermissionModeStop, string>>;
  readonly effect: Readonly<Record<PermissionModeStop, string>>;
  /** Marks the row of the stop this session runs in. */
  readonly current: string;
  /** Why a row cannot be chosen: no company grant for full access; the company left full-auto out; a v1 policy has no modes (`{mode}`). */
  readonly fullAccessGrant: string; readonly fullAutoOff: string; readonly unsupported: string;
}

export type ConfigPanelLayer = 'project' | 'global';
/** One key as the panel shows it: localized words only, plus the choices its schema allows and each layer's lock or note. */
export type ConfigPanelField = Readonly<{
  key: string; section: string; description: string; value: string; source: string; apply: string; expected: string;
  /** Values the schema enumerates (enum, boolean, constants); empty when only a typed entry fits. */
  choices: readonly Readonly<{ id: string; label: string; value: unknown }>[];
  /** A typed entry is offered (validated by the key's schema before anything is sent). */
  free: boolean;
  /** The written layer holds this key, so "back to the lower layer" (unset) is offered. */
  unsettable: boolean;
  /** The value is redacted: an entry is masked while typed. */
  sensitive: boolean;
  locks: Readonly<Record<ConfigPanelLayer, Readonly<{ blocked: string | null; note: string | null }>>>;
}>;
export type ConfigPanelView = Readonly<{ title: string; fields: readonly ConfigPanelField[]; notes: readonly string[] }>;
export type ConfigPanelWrite = Readonly<{ action: 'set' | 'unset'; keyPath: string; value?: unknown; layer: ConfigPanelLayer }>;
export type ConfigPanelOutcome = Readonly<{ status: 'applied' | 'approval-pending'; lines: readonly string[]; approvalId: string | null }>;
export interface ConfigPanelPort {
  inspect(): Promise<ConfigPanelView>;
  /** The typed value of an entry for one key, or the localized reason it does not fit (nothing is sent then). */
  parse(keyPath: string, text: string): Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false; reason: string }>;
  /** The L2 write port: principal'd, policy-checked, approval-aware; nothing else writes config. */
  write(request: ConfigPanelWrite): Promise<ConfigPanelOutcome>;
}
export interface ConfigPanelLabels {
  readonly hints: string; readonly scopes: Readonly<Record<ConfigPanelLayer, string>>;
  /** The section of top-level keys; the marker of the value in effect. */
  readonly general: string; readonly current: string;
  /** The focused key's "takes" row: `{expected}`. */
  readonly expected: string;
  /** Value-level rows: the typed entry and "back to the lower layer" (unset). */
  readonly freeEntry: string; readonly unset: string;
  /** `{key}`, `{expected}`: the entry prompt and its hint row. */
  readonly entryTitle: string; readonly entryHint: string;
}

export type McpScopeId = 'local' | 'project' | 'user';
export type McpPanelServer = Readonly<{ name: string; scope: string; status: string; attention: boolean; tools: string; realm: string; launch: string;
  trusted: boolean }>;
export type McpPanelList = Readonly<{ servers: readonly McpPanelServer[]; problems: readonly string[] }>;
/** One trust question of the wizard or a re-approval (the launch card, then the tools card): the window shows it, y says yes, n/Esc say no. */
export type McpTrustQuestion = Readonly<{ title: string; lines: readonly PanelLine[]; prompt: string }>;
export type McpTrustAsk = (question: McpTrustQuestion) => Promise<boolean | null>;
/** What the add wizard collected. Values of env and header entries are never shown again (masked while typed). */
export type McpServerDraft = Readonly<{ transport: 'stdio' | 'http'; name: string; target: string; args: readonly string[];
  env: Readonly<Record<string, string>>; headers: Readonly<Record<string, string>>; realm: string; scope: McpScopeId }>;
export type McpChoice = Readonly<{ id: string; label: string; detail?: string; blocked?: string }>;
export interface McpPanelPort {
  list(): Promise<McpPanelList>;
  detail(name: string): Promise<readonly PanelLine[]>;
  /** Revoke this server's trust (it asks again before it starts); re-approve with the trust windows; restart on next use; remove its entry. */
  revoke(name: string): Promise<readonly string[]>;
  approve(name: string, ask: McpTrustAsk): Promise<readonly string[]>;
  reconnect(name: string): Promise<readonly string[]>;
  remove(name: string): Promise<readonly string[]>;
  /** The wizard's engine: the same registry command as `deckent mcp add` (its trust decision through `ask`). It checks the name before any card:
   * a refused or taken name comes back as the error the wizard shows on its name step. */
  add(draft: McpServerDraft, ask: McpTrustAsk): Promise<readonly string[]>;
  readonly transports: readonly McpChoice[];
  readonly realms: readonly McpChoice[];
  readonly scopes: readonly McpChoice[];
}
export interface McpPanelLabels {
  readonly title: string; readonly hints: string; readonly add: string; readonly addDetail: string; readonly none: string;
  readonly actions: Readonly<Record<'detail' | 'revoke' | 'approve' | 'reconnect' | 'remove', string>>;
  /** Wizard steps: titles of the transport, realm and scope pickers, and the prompts of the text steps (`{step}` of `{steps}` in `step`). */
  readonly step: string;
  readonly steps: Readonly<Record<'transport' | 'name' | 'command' | 'url' | 'args' | 'env' | 'headers' | 'realm' | 'scope', string>>;
  readonly entryHints: Readonly<Record<'name' | 'command' | 'url' | 'args' | 'env' | 'headers', string>>;
  readonly pairInvalid: string; readonly empty: string;
  /** The trust window's key row. */
  readonly trustKeys: string;
}

/** An exact catalog model reference (provider id and version, catalog model id and version): never a bare or native model id. */
export type ModelPanelReference = Readonly<{ providerId: string; providerVersion: number; modelId: string; modelVersion: number }>;
/**
 * One model of `/model` (T4 MODEL-SWITCH): its words, the provider group it is listed under, and why it cannot be chosen now (not connected in
 * this scope, its key missing, not activated, not readable) — such a row is listed with its reason and is never pickable.
 */
export type ModelPanelChoice = Readonly<{ reference: ModelPanelReference; label: string; detail: string; group: string; blocked: string | null;
  /** The configured default (`terminal.chat.reference`). */
  configured: boolean }>;
export type ModelPanelView = Readonly<{ title: string; choices: readonly ModelPanelChoice[]; notes: readonly string[];
  /** Why "also make default" cannot be offered (null: it can). */
  defaultBlocked: string | null }>;
/** What the host binds for `/model`: the models and, when decided, the governed default write (the `/config` writer, approval-aware). */
export interface ModelPanelSource {
  inspect(): Promise<ModelPanelView>;
  makeDefault?(choice: ModelPanelChoice): Promise<ConfigPanelOutcome>;
}
/** `/model`'s full port: the host's source plus the session's own pin (the workline holds it; the next turn carries it, protocol v23). */
export interface ModelPanelPort extends ModelPanelSource {
  pinned(): ModelPanelReference | null;
  pin(choice: ModelPanelChoice): void;
}
export interface ModelPanelLabels {
  readonly hints: string;
  /** Scope step: this session only; this session and the user default. */
  readonly session: string; readonly sessionAndDefault: string;
  /** Row marks: pinned for this session; the configured default. */
  readonly pinnedMark: string; readonly configuredMark: string;
  /** `{model}`: the notice after a pin. */
  readonly pinned: string;
}

/** One `/provider` kind (T4 PROVIDER-CONNECT): its state in words, the key's store name (never a value) and what the connect flow asks. */
export type ProviderPanelKind = Readonly<{ id: string; label: string; detail: string; blocked: string | null; keyName: string | null; keyStored: boolean;
  endpointEditable: boolean; endpointDefault: string | null; keyRequired: boolean }>;
export type ProviderPanelView = Readonly<{ title: string; kinds: readonly ProviderPanelKind[]; notes: readonly string[] }>;
export type ProviderConnectRequest = Readonly<{ kind: string; endpoint: string | null; key: string | null }>;
/** A connect's typed result as labelled rows (no key, no answer body); `stored`: the key went to the secret store. */
export type ProviderConnectOutcome = Readonly<{ stored: boolean; title: string; lines: readonly PanelLine[] }>;
export interface ProviderPanelPort {
  inspect(): Promise<ProviderPanelView>;
  /** The localized reason a typed endpoint is refused (https anywhere, plain http only on this machine), or null. */
  endpoint(kind: string, text: string): string | null;
  /** The free check, then (only on success) the key into the secret store through the runtime service. */
  connect(request: ProviderConnectRequest): Promise<ProviderConnectOutcome>;
  /** Removes the kind's stored key through the runtime service. */
  disconnect(kind: string): Promise<readonly string[]>;
  /** The transparency rows the key step shows: how the key is kept and who else can read it. */
  readonly transparency: readonly PanelLine[];
}
export interface ProviderPanelLabels {
  readonly title: string; readonly hints: string;
  readonly actions: Readonly<Record<'connect' | 'replace' | 'disconnect', string>>;
  readonly endpointTitle: string; readonly endpointHint: string;
  /** `{kind}`: the key step's title; its hints (required key / optional key). */
  readonly keyTitle: string; readonly keyHint: string; readonly keyOptionalHint: string; readonly keyRequired: string;
  readonly checking: string; readonly resultHints: string;
  /** `{kind}`: the question before a disconnect; its key row. */
  readonly disconnectTitle: string; readonly disconnectKeys: string;
  readonly empty: string;
}

/** Shared words of every panel window. */
export interface PanelLabels {
  readonly picker: PickerLabels;
  readonly position: string;
  readonly loading: string;
  readonly mode: ModePanelLabels;
  readonly config: ConfigPanelLabels;
  readonly mcp: McpPanelLabels;
  readonly model: ModelPanelLabels;
  readonly provider: ProviderPanelLabels;
}
export interface PanelPorts {
  readonly mode?: ModePanelPort;
  readonly config?: ConfigPanelPort;
  readonly mcp?: McpPanelPort;
  readonly model?: ModelPanelPort;
  readonly provider?: ProviderPanelPort;
}
