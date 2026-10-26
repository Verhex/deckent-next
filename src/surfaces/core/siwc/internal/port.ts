import type { ConfigLoadOptions, Locale } from '#platform/index.js';
export type { SubscriptionConnectionRequest as SiwcRequest, SubscriptionConnectionResult as SiwcResult } from '#domain/index.js';
import type { SubscriptionConnectionRequest as SiwcRequest, SubscriptionConnectionResult as SiwcResult } from '#domain/index.js';
/** Presentation callbacks remain in the person's process; neither callbacks nor URLs are runtime/MCP input. */
export type SiwcHandler = (root: string, request: SiwcRequest, options: ConfigLoadOptions,
  presentation?: Readonly<{ signal?: AbortSignal; fallback?: (url: string) => void }>) => Promise<SiwcResult>;
export interface SiwcWindowPort { readonly locale: Locale; readonly connection: string; execute(request: Omit<SiwcRequest, 'scopeId'>,
  presentation?: Readonly<{ signal?: AbortSignal; fallback?: (url: string) => void }>): Promise<SiwcResult> }
