import type { PermissionModeView } from '#domain/index.js';
import type { PermissionModeStop } from '#surfaces/core/terminal-render/index.js';
import type { PickerLabels } from '#surfaces/core/terminal-picker/index.js';

/**
 * T3 L4 PANELS: the ports and words of the interactive `/mode`, `/config` and `/mcp` windows. This unit only presents and collects a choice;
 * every read, write, policy decision and trust record stays behind the port the trusted composition binds (the same paths as the text
 * commands and `deckent config|mcp`). All words come in already localized; nothing here calls the catalog.
 */
export type PanelKind = 'mode' | 'config' | 'mcp';
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
  /** SLASH-WINDOWS: the header row of the window (`/mode show` moved here): `now` has `{mode}`; `inert` says no rule is mode-eligible in this scope. */
  readonly now?: string; readonly inert?: string;
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

/** Shared words of every panel window. */
export interface PanelLabels {
  readonly picker: PickerLabels;
  readonly position: string;
  readonly loading: string;
  readonly mode: ModePanelLabels;
  readonly config: ConfigPanelLabels;
  readonly mcp: McpPanelLabels;
}
export interface PanelPorts {
  readonly mode?: ModePanelPort;
  readonly config?: ConfigPanelPort;
  readonly mcp?: McpPanelPort;
}
