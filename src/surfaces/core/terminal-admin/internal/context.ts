import type { ModelReference } from '#domain/index.js';
import type { PermissionModeQuery, PermissionModeView } from '#domain/index.js';
import type { ConfigLoadOptions, Locale } from '#platform/index.js';
import type { ModelCatalogInspectionHandler, ProviderSpendAccountInspectionHandler } from '#surfaces/core/cli-models/index.js';

/** The slice of the host's command context the read-only management commands use; the CLI context satisfies it. */
export interface TerminalAdminContext {
  readonly describeTerminalChatPlan?: (root: string, options: ConfigLoadOptions) => Promise<Readonly<{ status: 'ready' | 'not-configured' | 'model-not-declared'; reference: ModelReference | null }>>;
  readonly inspectModelCatalog?: ModelCatalogInspectionHandler;
  readonly inspectProviderSpendAccount?: ProviderSpendAccountInspectionHandler;
  readonly inspectPermissionMode?: (root: string, input: PermissionModeQuery, options: ConfigLoadOptions, signal?: AbortSignal) => Promise<PermissionModeView>;
  readonly inspectSurfaceAccess?: (root: string, scopeId: string, options: ConfigLoadOptions) => Promise<Readonly<{ binding: string; kinds: readonly string[] }> | null>;
  readonly describeRuntimeService?: (root: string, options: ConfigLoadOptions) => Promise<Readonly<{ instanceId: string; processId?: number | undefined; build?: Readonly<{ sourceCommit: string | null }> | undefined }>>;
}

/** What one command call reads: every call re-asks its producers; nothing here is remembered between calls. */
export interface TerminalAdminCall {
  readonly root: string;
  readonly scopeId: string;
  readonly options: ConfigLoadOptions;
  readonly locale: Locale;
  readonly context: TerminalAdminContext;
}
