import { persistedDateTime, persistedUrl } from '#platform/core/validate/index.js';
import { z } from 'zod';
const source = persistedUrl().max(4096).refine(value => {
  const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
});
/** Full URLs, including path and port, are consent data; a hostname alone never authorizes another source. */
export const workerImageConsentSchema = z.strictObject({ operation: z.literal('worker-image.consent@1'), id: z.string().min(1).max(128),
  imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/u).optional(),
  person: z.strictObject({ id: z.string().min(1), issuer: z.string().min(1), subject: z.string().min(1) }), scopeId: z.string().min(1),
  providers: z.array(z.string().regex(/^[a-z0-9]{1,32}$/u)).min(1).max(1).refine(values => new Set(values).size === values.length),
  sources: z.array(source).max(128), proxy: persistedUrl().max(4096).nullable().refine(value => {
    if (value === null) return true; const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  }), recipeDigest: z.string().regex(/^[a-f0-9]{64}$/u), baseRef: z.string().min(1).max(255), createdAt: persistedDateTime(),
});
export type WorkerImageConsent = z.infer<typeof workerImageConsentSchema>;
