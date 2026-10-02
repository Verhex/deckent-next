import type { z } from 'zod';
import { DeckentError, ErrorRegistry } from '#platform/index.js';
import type { AuditEvent, VerifiedPrincipal } from '#domain/index.js';
import type { DeckentConfig } from '#platform/index.js';
import type { Environment } from '#platform/index.js';
export type ConfigLayer = 'project' | 'global';
export type ConfigSource = 'default' | ConfigLayer | 'env';
export interface ConfigFieldView {
  readonly key: string; readonly value: unknown; readonly defaultValue: unknown; readonly source: ConfigSource;
  readonly descriptionKey: string; readonly description: string; readonly schema: unknown;
  readonly binding: { readonly state: 'bound'; readonly consumers: readonly string[] } | { readonly state: 'declared-only'; readonly reason: string };
  readonly apply: 'live' | 'restart'; readonly redacted: boolean;
}
export interface ConfigSnapshot {
  readonly document: Record<string, unknown>; readonly global: Record<string, unknown>; readonly project: Record<string, unknown>;
  readonly effective: DeckentConfig; readonly digest: string | null; readonly layer: ConfigLayer; readonly env: Environment;
}
export interface ConfigWriteInput {
  readonly keyPath: string; readonly value?: unknown; readonly layer?: ConfigLayer; readonly expect?: string | null;
  readonly principal: VerifiedPrincipal; readonly scopeId: string; readonly commandId: string;
}
export interface ConfigWriteResult {
  readonly keyPath: string; readonly layer: ConfigLayer; readonly beforeDigest: string | null; readonly afterDigest: string;
  readonly backupPath: string | null; readonly overridden: boolean;
}
export interface ConfigPlan { readonly document: Record<string, unknown>; readonly event: AuditEvent }
export interface ConfigDocumentPort {
  snapshot(layer: ConfigLayer): Promise<ConfigSnapshot>;
  publish(input: ConfigWriteInput, plan: (snapshot: ConfigSnapshot) => Promise<ConfigPlan>): Promise<ConfigWriteResult>;
}
export interface ConfigAuthorityPort {
  authorize(input: ConfigWriteInput): Promise<string>;
  audit(event: AuditEvent): Promise<void>;
}
export class ConfigApplicationError extends DeckentError {
  constructor(code: string) {
    const error = ErrorRegistry.createError(code);
    super(code, error.message, error.suggestion, error.docLink, error.whatHappened, error.why, error.howToFix, error.category, undefined, error.localize, error.params);
    this.name = 'ConfigApplicationError';
  }
}
export interface ConfigDefinition { readonly schema: z.ZodTypeAny; readonly descriptionKey: string;
  readonly binding: ConfigFieldView['binding']; readonly apply: ConfigFieldView['apply'] }
