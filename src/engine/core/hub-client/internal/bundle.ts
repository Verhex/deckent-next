import { z } from 'zod';
import { HUB_LIMITS, HubError, canonicalHubJson, hubEnvelopeSchema, hubFilePathSchema, hubKeyDelegationSchema, hubPackageSchema, requireBoundedHubJson } from '#domain/index.js';
import { verifyHubPackageFiles } from '#engine/core/hub/index.js';
import type { HubBundle } from './contract.js';
const bundleSchema = z.object({ manifest: hubPackageSchema, envelope: hubEnvelopeSchema,
  files: z.array(z.object({ path: hubFilePathSchema, base64: z.string().max(HUB_LIMITS.packageMaxBytes) }).strict()).max(HUB_LIMITS.packageMaxFiles),
  delegation: hubKeyDelegationSchema.optional() }).strict();
/** File transport only; never discovers sources, opens paths or performs network I/O. */
export function decodeHubBundle(bytes: Uint8Array): HubBundle {
  if (bytes.byteLength > HUB_LIMITS.packageMaxBytes) throw new HubError('HUB_LIMIT_EXCEEDED');
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new HubError('HUB_PACKAGE_INVALID'); }
  requireBoundedHubJson(value);
  const parsed = bundleSchema.safeParse(value);
  if (!parsed.success) throw new HubError('HUB_PACKAGE_INVALID');
  const files = parsed.data.files.map(file => {
    const data = Buffer.from(file.base64, 'base64');
    if (data.toString('base64') !== file.base64) throw new HubError('HUB_PACKAGE_INVALID');
    return { path: file.path, bytes: data };
  });
  verifyHubPackageFiles(parsed.data.manifest, files);
  return { manifest: parsed.data.manifest, envelope: parsed.data.envelope, files, ...(parsed.data.delegation ? { delegation: parsed.data.delegation } : {}) };
}
export function encodeHubBundle(bundle: HubBundle): Uint8Array {
  verifyHubPackageFiles(bundle.manifest, bundle.files);
  const value = { manifest: bundle.manifest, envelope: bundle.envelope, ...(bundle.delegation ? { delegation: bundle.delegation } : {}),
    files: [...bundle.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(file => ({ path: file.path, base64: Buffer.from(file.bytes).toString('base64') })) };
  const bytes = Buffer.from(canonicalHubJson(value));
  decodeHubBundle(bytes);
  return bytes;
}
