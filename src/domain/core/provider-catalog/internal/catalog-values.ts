import { z } from 'zod';
import { NATIVE_MODEL_ID_MAX_LENGTH } from './catalog.js';
import { nativeCliIds } from './native-cli.js';

/** How a channel reaches its models: a subscription CLI inside the worker image, an HTTP API with a key, or a local server. */
export const CATALOG_CHANNEL_KINDS = Object.freeze(['native-cli', 'http-api', 'local-server'] as const);
export const NATIVE_CLI_CHANNELS = nativeCliIds;
export const CATALOG_BILLING_KINDS = Object.freeze(['subscription', 'per-token', 'self-hosted'] as const);
export const CATALOG_PRICING_KINDS = Object.freeze(['per-token', 'subscription', 'unknown'] as const);
export const MODEL_LIFECYCLE_STATES = Object.freeze(['active', 'legacy', 'deprecated', 'retired'] as const);
export const REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const);
export const EXACT_MODEL_ID_MAX_LENGTH = 256;
const CATALOG_ALIAS_MAX = 64;

/** An exact model id as a provider's API names it: printable, trimmed, never option-like. Aliases share the grammar and are data. */
export const exactModelIdSchema = z.string().min(1).max(Math.min(EXACT_MODEL_ID_MAX_LENGTH, NATIVE_MODEL_ID_MAX_LENGTH)).refine(value => value.trim() === value
  && !value.startsWith('-') && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127));
/** A calendar day (UTC, ISO 8601 `YYYY-MM-DD`); validated arithmetically so the domain stays clock-free. */
export const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return month >= 1 && month <= 12 && day >= 1 && day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
});
export const cliVersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/).max(64);
export const aliasesSchema = z.array(exactModelIdSchema).max(CATALOG_ALIAS_MAX).readonly();
