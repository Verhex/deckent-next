import { persistedString, persistedInteger, persistedUrl } from '#domain/index.js';
import { z } from 'zod';
import metering from './metering.json' with { type: 'json' };

const positive = persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const registrySchema = z.strictObject({ get schemaVersion() { return z.literal(1); }, get retrievedAt() { return z.string().regex(/^\d{4}-\d{2}-\d{2}$/); },
  get sources() { return z.record(z.string(), persistedUrl().startsWith('https://')).refine(sources => Object.keys(sources).length > 0); },
  get note() { return persistedString(z.string().min(1)); }, get tokenEstimate() { return z.strictObject({ requestOverheadTokens: positive,
    messageOverheadTokens: positive, toolOverheadTokens: positive }); } });

/** Adapter-owned policy. An incomplete or incompatible snapshot fails at load with ZodError; no defaults are substituted. */
const registry = registrySchema.parse(metering);
export const OPENAI_CHAT_METERING = Object.freeze({ ...registry, sources: Object.freeze(registry.sources),
  tokenEstimate: Object.freeze(registry.tokenEstimate) });
