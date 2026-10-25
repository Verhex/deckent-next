import { z } from 'zod';
import { encodeCommandProjection } from '#domain/core/command/index.js';
import { HUB_LIMITS } from './registry.js';

export const HUB_ERROR_CODES = ['HUB_PACKAGE_SCHEMA_UNSUPPORTED', 'HUB_ENVELOPE_SCHEMA_UNSUPPORTED', 'HUB_FEED_SCHEMA_UNSUPPORTED',
  'HUB_PACKAGE_INVALID', 'HUB_ENVELOPE_INVALID', 'HUB_FEED_INVALID', 'HUB_LIMIT_EXCEEDED', 'HUB_DIGEST_MISMATCH', 'HUB_SIGNATURE_INVALID',
  'HUB_SIGNER_UNTRUSTED', 'HUB_IDENTITY_MISMATCH', 'HUB_FOREIGN_PACKAGE', 'HUB_FEED_REPLAYED', 'HUB_FEED_STALE', 'HUB_SKILL_INVALID'] as const;
export type HubErrorCode = typeof HUB_ERROR_CODES[number];
export class HubError extends Error {
  constructor(readonly code: HubErrorCode) { super(code); this.name = 'HubError'; }
}
/** Bound untrusted structured input before Zod walks it. Repeated object references and cycles are refused. */
export function requireBoundedHubJson(input: unknown, maxBytes = HUB_LIMITS.packageMaxBytes): void {
  const stack: { value: unknown; depth: number }[] = [{ value: input, depth: 0 }], seen = new Set<object>();
  let bytes = 0;
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (depth > 32) throw new HubError('HUB_LIMIT_EXCEEDED'); // existing Deckent projection depth invariant
    if (typeof value === 'string') {
      if (value.length > maxBytes) throw new HubError('HUB_LIMIT_EXCEEDED');
      bytes += new TextEncoder().encode(JSON.stringify(value)).length;
    } else if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) bytes += String(value).length;
    else if (typeof value === 'object' && value && (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype)) {
      if (seen.has(value)) throw new HubError('HUB_PACKAGE_INVALID');
      seen.add(value);
      // Each child needs at least one byte; bound enumeration and the pending stack before copying it.
      const length = Array.isArray(value) ? value.length : Object.keys(value).length;
      const widthMax = Math.max(HUB_LIMITS.skillReadMaxFiles, HUB_LIMITS.feedPageMax, HUB_LIMITS.itemsMax);
      if (length > widthMax || length > maxBytes || stack.length + length > maxBytes) throw new HubError('HUB_LIMIT_EXCEEDED');
      if (Array.isArray(value) && Object.keys(value).length !== value.length) throw new HubError('HUB_PACKAGE_INVALID');
      bytes += 2 + Math.max(0, length - 1);
      for (const [key, child] of Object.entries(value)) {
        if (key.length > maxBytes) throw new HubError('HUB_LIMIT_EXCEEDED');
        if (!Array.isArray(value)) bytes += new TextEncoder().encode(JSON.stringify(key)).length + 1;
        if (bytes > maxBytes) throw new HubError('HUB_LIMIT_EXCEEDED');
        stack.push({ value: child, depth: depth + 1 });
      }
    } else throw new HubError('HUB_PACKAGE_INVALID');
    if (bytes > maxBytes) throw new HubError('HUB_LIMIT_EXCEEDED');
  }
}
export function parseHubContract<S extends z.ZodTypeAny>(schema: S, input: unknown, invalid: HubErrorCode, unsupported: HubErrorCode): z.infer<S> {
  requireBoundedHubJson(input);
  if (input && typeof input === 'object' && 'schemaVersion' in input && input.schemaVersion !== 1) throw new HubError(unsupported);
  const result = schema.safeParse(input);
  if (!result.success) {
    if (result.error.issues.some(issue => issue.code === 'too_big')) throw new HubError('HUB_LIMIT_EXCEEDED');
    throw new HubError(invalid);
  }
  return result.data;
}
/** Canonical JSON reuses Deckent's encoder, removing only the tag framing. Strings remain byte-exact. */
export function canonicalHubJson(value: unknown): string {
  requireBoundedHubJson(value);
  const tag = 'hub-json:1';
  return encodeCommandProjection(tag, value).slice(JSON.stringify(tag).length + 1);
}
