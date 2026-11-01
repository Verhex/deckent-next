import { persistedDateTime, persistedUrl } from '#platform/core/validate/index.js';
import { z } from 'zod';
const source = persistedUrl().max(4096).refine(value => {
  const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
});
/** Full URLs, including path and port, are consent data; a hostname alone never authorizes another source. */
export const workerImageConsentSchema = z.strictObject({ get operation() { return z.literal('worker-image.consent@1'); }, get id() { return z.string().min(1).max(128); },
  get imageId() { return z.string().regex(/^sha256:[a-f0-9]{64}$/u).optional(); },
  get person() { return z.strictObject({ id: z.string().min(1), issuer: z.string().min(1), subject: z.string().min(1) }); }, get scopeId() { return z.string().min(1); },
  get providers() { return z.array(z.string().regex(/^[a-z0-9]{1,32}$/u)).min(1).max(1).refine(values => new Set(values).size === values.length); },
  get sources() { return z.array(source).max(128); }, get proxy() { return persistedUrl().max(4096).nullable().refine(value => {
    if (value === null) return true; const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  }); }, get recipeDigest() { return z.string().regex(/^[a-f0-9]{64}$/u); }, get baseRef() { return z.string().min(1).max(255); }, get createdAt() { return persistedDateTime(); },
});
export type WorkerImageConsent = z.infer<typeof workerImageConsentSchema>;
