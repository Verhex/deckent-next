import type { PermissionModeView } from '#domain/index.js';
import type { PermissionModeStop } from '#surfaces/core/terminal-render/index.js';
import type { PickerLabels } from '#surfaces/core/terminal-picker/index.js';
import type { ModelProviderLabel } from '#surfaces/core/terminal-render/index.js';

/**
 * T3 L4 PANELS: the ports and words of the interactive `/mode`, `/config` and `/mcp` windows (T4: `/model` and `/provider`). This unit only presents and collects a choice;
 * every read, write, policy decision and trust record stays behind the port the trusted composition binds (the same paths as the text
 * commands and `deckent config|mcp`). All words come in already localized; nothing here calls the catalog.
 */
export type PanelKind = 'mode' | 'config' | 'mcp' | 'model' | 'provider' | 'policy';
export type PanelNotice = Readonly<{ level: 'info' | 'warning' | 'error'; text: string; identity?: ModelProviderLabel }>;
/** A labelled body row of a panel window (detail views, trust questions). Values from a producer go through the decision projection. */
export type PanelLine = Readonly<{ label: string; text: string; tone?: 'warning' | 'muted' | 'success' }>;

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
  /** SLASH-WINDOWS: the header row of the window (`/mode show` moved here): `now` has `{mode}`; `inert` says no rule is mode-eligible in this scope. */
  readonly now?: string; readonly inert?: string;
}

export type ConfigPanelLayer = 'project' | 'global';
/** One key as the panel shows it: localized words only, plus the choices its schema allows and each layer's lock or note. */
export type ConfigPanelField = Readonly<{
  key: string; section: string; description: string; value: string; source: string; apply: string; expected: string;
  /** Values the schema enumerates (enum, boolean, constants); empty when the source is unavailable or the document needs a record editor. */
  choices: readonly Readonly<{ id: string; label: string; value: unknown; detail?: string; blocked?: string }>[];
  /** A typed entry is offered (validated by the key's schema before anything is sent). */
  free: boolean;
  records?: boolean;
  stepper?: import('#platform/index.js').ConfigStepper | null;
  readOnly?: string | null;
  generated?: boolean;
  choiceNotice?: string | null;
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
  readonly records?: import('#surfaces/core/config/index.js').ConfigRecordPort;
  inspect(): Promise<ConfigPanelView>;
  /** The typed value of an entry for one key, or the localized reason it does not fit (nothing is sent then). */
  parse(keyPath: string, text: string): Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false; reason: string }>;
  /** The L2 write port: principal'd, policy-checked, approval-aware; nothing else writes config. */
  write(request: ConfigPanelWrite): Promise<ConfigPanelOutcome>;
}
export interface ConfigPanelLabels {
  readonly records: Readonly<Record<'edit' | 'add' | 'remove' | 'import' | 'save' | 'before' | 'after' | 'browse' | 'select' | 'empty', string>>;
  readonly hints: string; readonly scopes: Readonly<Record<ConfigPanelLayer, string>>;
  /** The section of top-level keys; the marker of the value in effect. */
  readonly general: string; readonly current: string;
  /** The focused key's "takes" row: `{expected}`. */
  readonly expected: string;
  /** Value-level rows: the typed entry and "back to the lower layer" (unset). */
  readonly freeEntry: string; readonly unset: string;
  readonly summary: string;
  readonly stepper: string; readonly stepperHint: string; readonly regenerate: string; readonly preview: string; readonly previewHint: string;
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
export type ModelPanelChoice = Readonly<{ reference: ModelPanelReference; label: string; providerLabel?: string; detail: string; group: string; blocked: string | null;
  /** Shown dimmed under the list for the focused row only (owner 2026-10-08: human labels first, exact ids and digests never in front): the exact
   * reference, and for a locked row the governed command that would fix it. */
  exact: string; command: string | null;
  /** The configured default (`terminal.chat.reference`). */
  configured: boolean }>;
export type ModelPanelView = Readonly<{ title: string; choices: readonly ModelPanelChoice[]; notes: readonly string[];
  /** Why "also make default" cannot be offered (null: it can). */
  defaultBlocked: string | null }>;
/** What the host binds for `/model`: the models and, when decided, the governed default write (the `/config` writer, approval-aware). */
/** T4-B (owner 2026-10-08, Jev 77898686): the default was written but this project names its own model, which keeps winning here. */
export type ModelDefaultOutcome = ConfigPanelOutcome & Readonly<{ shadow?: Readonly<{ projectModel: string }> | null }>;
export interface ModelPanelSource {
  inspect(): Promise<ModelPanelView>;
  /** Rechecks runnability and refreshes an eligible stale activation through its governed owner before any session pin. */
  prepare?(choice: ModelPanelChoice, reasoning?: 'off'): Promise<void>;
  /** Stage 1: create or change the scope budget from this window (absent: not offered). */
  readonly budget?: BudgetPanelPort;
  /** CACHE-SLICE1: the governed one-step "turn the 5-minute prompt cache on" for existing profiles (absent: not offered). */
  readonly cache?: CachePanelPort;
  /** OpenAI wire protocol migration, with a mandatory preview and existing governed writer. */
  readonly protocol?: CachePanelPort;
  readonly workspace?: WorkspacePanelPort;
  /** CACHE-SLICE1: the conversation's measured context when it is at or above the registry threshold (null: below it or not measured yet); a
   * model switch then asks "new context / continue" before it pins. */
  largeContext?(): number | null;
  /** Current session preference, rechecked before pinning. */
  reasoning?(): 'off' | undefined;
  reasoningOffSupported?(reference: ModelPanelReference | null): Promise<boolean>;
  makeDefault?(choice: ModelPanelChoice): Promise<ModelDefaultOutcome>;
  /** The two governed answers to a shadowing project model (the `/config` writer on the project layer, `terminal.chat.reference` only): `remove`
   * drops the project's model so the user default applies; `align` makes the project's model this one. */
  resolveShadow?(choice: ModelPanelChoice, action: 'remove' | 'align'): Promise<ConfigPanelOutcome>;
}
/** `/model`'s full port: the host's source plus the session's own pin (the workline holds it; the next turn carries it, protocol v23). `fresh`: the
 * person chose a new context for the switch (the conversation keeps only their own instructions). */
export interface ModelPanelPort extends ModelPanelSource {
  pinned(): ModelPanelReference | null;
  pin(choice: ModelPanelChoice, fresh?: boolean): void;
}
/** CACHE-SLICE1: what the cache migration would change, in words (the host builds them from each profile's own tariff), or nothing to offer. */
export type CachePanelView = Readonly<{ detail: string; lines: readonly PanelLine[] }>;
export interface WorkspacePanelPort {
  inspect(): Promise<readonly Readonly<{ id: string; label: string; detail: string }>[]>;
  list(profileId: string): Promise<readonly Readonly<{ id: string; name: string }>[]>;
  apply(profileId: string, workspaceId: string): Promise<ConfigPanelOutcome>;
}
export interface CachePanelPort {
  inspect(): Promise<CachePanelView | null>;
  /** The governed `/config` writes (policy, approval, audit), read fresh at the answer; the outcome's lines are the one summary. */
  apply(): Promise<ConfigPanelOutcome>;
}
export interface CachePanelLabels {
  /** The list row; the window title; its two answers; its key hint. */
  readonly entry: string; readonly title: string; readonly confirm: string; readonly cancel: string; readonly hints: string;
}
/** CACHE-SLICE1: the model-switch question over a large context (`{tokens}` measured, `{model}` the chosen one). */
export interface ModelSwitchLabels { readonly title: string; readonly fresh: string; readonly keep: string; readonly freshDone: string; readonly keepDone: string }
export interface ModelPanelLabels {
  readonly hints: string;
  /** Scope step: this session only; this session and the user default. */
  readonly session: string; readonly sessionAndDefault: string;
  /** Row marks: pinned for this session; the configured default. */
  readonly pinnedMark: string; readonly configuredMark: string;
  /** `{model}`: the notice after a pin. */
  readonly pinned: string;
  /** T4-B shadow window: `{model}` the project's model; its two governed choices and "keep as it is". */
  readonly shadowTitle: string; readonly shadowRemove: string; readonly shadowAlign: string; readonly shadowKeep: string;
  readonly switch: ModelSwitchLabels;
}

/** One `/provider` kind (T4 PROVIDER-CONNECT): its state in words, the key's store name (never a value) and what the connect flow asks. */
export type ProviderPanelKind = Readonly<{ id: string; label: string; detail: string; blocked: string | null; keyName: string | null; keyStored: boolean;
  endpointEditable: boolean; endpointDefault: string | null; keyRequired: boolean;
  /** Owner 2026-10-08 (D3): where the kind takes an address it is chosen from this list (configured server, known local servers, the provider's
   * default); a typed address is only the list's last row, checked and previewed. A kind with a fixed endpoint has none. */
  endpointChoices: readonly Readonly<{ id: string; label: string; url: string }>[];
  /** T4-B: the models this kind can connect (its catalog seed, or the provider catalog's declared models), chosen from the list; empty: none.
   * `modelBlocked`: why "connect a model" cannot be offered now (e.g. no key stored yet), null when it can; a model's own `blocked` (stage 1:
   * no verified price) locks that row only. */
  models: readonly Readonly<{ id: string; label: string; detail: string; blocked?: string }>[]; modelBlocked: string | null;
  /** Seedless kinds offer the model action before a list exists; the selected address supplies that list. */
  discoversModels?: boolean;
  /** K6: shown on the row (muted) when the kind stores a key but no model can be connected to it yet. */
  pendingNote?: string;
  /** (c) A key under a name no row uses any more: listed with a warning, its only action is removal. */
  legacy?: true }>;
export type ProviderPanelView = Readonly<{ title: string; kinds: readonly ProviderPanelKind[]; notes: readonly string[];
  invocableModels?: readonly import('#engine/index.js').InvocableModel[] }>;
export type ProviderConnectRequest = Readonly<{ kind: string; endpoint: string | null; key: string | null }>;
/** A connect's typed result as labelled rows (no key, no answer body); `stored`: the key went to the secret store. */
export type ProviderConnectOutcome = Readonly<{ stored: boolean; title: string; lines: readonly PanelLine[] }>;
/** T4-B `models.connect` from the window: the model chosen from the kind's list (and the address, where the kind takes one). */
export type ProviderModelRequest = Readonly<{ kind: string; endpoint: string | null; model: string }>;
/** Its typed result as labelled rows, the one system summary line it leaves, and the approval to answer when policy asked for one. */
export type ProviderModelOutcome = Readonly<{ connected: boolean; title: string; lines: readonly PanelLine[]; summary: string; approvalId: string | null }>;
export interface ProviderPanelPort {
  inspect(): Promise<ProviderPanelView>;
  /** A typed address checked by the endpoint rule (https anywhere, plain http only on this machine): the base it becomes and the URL the free
   * check will call (the preview), or the localized reason it is refused. */
  endpoint(kind: string, text: string): Readonly<{ ok: true; base: string; check: string }> | Readonly<{ ok: false; reason: string }>;
  /** The free check, then (only on success) the key into the secret store through the runtime service. */
  connect(request: ProviderConnectRequest): Promise<ProviderConnectOutcome>;
  /** Removes the kind's stored key through the runtime service. */
  disconnect(kind: string): Promise<readonly string[]>;
  /** T4-B: the key's store name for this kind at this address (the generic row derives it from the host), shown before anything is saved. */
  keyName?(kind: string, endpoint: string | null): string | null;
  /** T4-B: connects the chosen model through the governed `models.connect` operation (absent: the action is not offered). */
  connectModel?(request: ProviderModelRequest): Promise<ProviderModelOutcome>;
  listModels?(kind: string, endpoint: string | null): Promise<ProviderPanelKind['models']>;
  /** The transparency rows the key step shows: how the key is kept and who else can read it. */
  readonly transparency: readonly PanelLine[];
  /** Stage 1: create or change the scope budget from this window (absent: not offered). */
  readonly budget?: BudgetPanelPort;
  /** CACHE-SLICE1: the same cache migration as `/model` (absent: not offered). */
  readonly cache?: CachePanelPort;
}
export interface ProviderPanelLabels {
  readonly title: string; readonly hints: string;
  readonly actions: Readonly<Record<'connect' | 'replace' | 'disconnect' | 'model', string>>;
  /** T4-B: the model list's title (`{kind}`), its empty note, and the key-name row the key step shows. */
  readonly modelTitle: string; readonly modelEmpty: string; readonly keyName: string;
  readonly endpointTitle: string; readonly endpointHint: string;
  /** The list's last row (a typed address) and its preview question: title, the two rows' labels, the key row. */
  readonly endpointOther: string; readonly previewTitle: string; readonly previewAddress: string; readonly previewCheck: string; readonly previewKeys: string;
  /** `{kind}`: the key step's title; its hints (required key / optional key). */
  readonly keyTitle: string; readonly keyHint: string; readonly keyOptionalHint: string; readonly keyRequired: string;
  readonly checking: string; readonly resultHints: string;
  /** `{kind}`: the question before a disconnect; its key row. */
  readonly disconnectTitle: string; readonly disconnectKeys: string;
  readonly empty: string;
}

/** Shared words of every panel window. */
/**
 * Stage 1 (owner 2026-10-08): the scope's one shared USD budget, created or changed from `/model` and `/provider` through the governed spend
 * command. The amount comes from presets or a bounded arrow-key step, never typed; a confirm step comes before anything is sent.
 * `action` null: no action here (`note` says why, e.g. a budget declared in configuration whose account opens at the first call).
 */
export type BudgetPanelView = Readonly<{ action: 'create' | 'change' | null; current: string | null; note: string | null; frozen: boolean;
  settledUsd?: number;
  presets: readonly number[]; min: number; max: number; step: number; start: number }>;
export type BudgetPanelOutcome = Readonly<{ ok: boolean; line: string }>;
export interface BudgetPanelPort {
  inspect(): Promise<BudgetPanelView>;
  apply(request: Readonly<{ action: 'create' | 'change'; usd: number; unfreeze: boolean }>): Promise<BudgetPanelOutcome>;
}
export interface BudgetPanelLabels {
  /** The list rows that open the window; `{current}` is the budget in effect. */
  readonly create: string; readonly change: string; readonly changeDetail: string;
  /** `{usd}` of a preset row; the bounded-step row; the stepper title and its key hint. */
  readonly preset: string; readonly other: string; readonly stepperTitle: string; readonly hints: string;
  /** `{usd}`: the confirm window's title; its two (three when frozen) answers. */
  readonly confirmTitle: string; readonly confirm: string; readonly confirmUnfreeze: string; readonly cancel: string;
  readonly belowSettled?: string;
}
export interface PanelLabels {
  readonly policy?: PolicyPanelLabels;
  readonly picker: PickerLabels;
  readonly position: string;
  readonly loading: string;
  readonly mode: ModePanelLabels;
  readonly config: ConfigPanelLabels;
  readonly mcp: McpPanelLabels;
  readonly model: ModelPanelLabels;
  readonly provider: ProviderPanelLabels;
  readonly budget: BudgetPanelLabels;
  readonly cache: CachePanelLabels;
  readonly protocol?: CachePanelLabels;
  readonly workspace?: Readonly<{ entry: string; title: string; confirm: string; empty: string; note: string; hints: string }>;
}
export interface PanelPorts {
  readonly policy?: PolicyPanelPort;
  readonly mode?: ModePanelPort;
  readonly config?: ConfigPanelPort;
  readonly mcp?: McpPanelPort;
  readonly model?: ModelPanelPort;
  readonly provider?: ProviderPanelPort;
}
/** Localized presentation of the shared typed MCP capability contract. No typed values or rule editor. */
export interface PolicyPanelPort {
  scopes(): Promise<readonly string[]>;
  inspect(scopeId: string): Promise<Readonly<{ groups: readonly Readonly<{ id: string; label: string; detail: string; note: string }>[] }>>;
  preview(scopeId: string, groupId: string, action: 'grant' | 'revoke'): Promise<PolicyPanelPreview>;
  apply(preview: PolicyPanelPreview): Promise<readonly PanelNotice[]>;
}
export interface PolicyPanelPreview {
  readonly scopeId: string; readonly groupId: string; readonly action: 'grant' | 'revoke'; readonly digest: string;
  readonly lines: readonly PanelLine[]; readonly applicable: boolean;
}
export interface PolicyPanelLabels {
  readonly title: string; readonly scope: string; readonly groups: string; readonly preview: string;
  readonly grant: string; readonly revoke: string; readonly confirm: string; readonly back: string; readonly hints: string; readonly empty: string;
}
