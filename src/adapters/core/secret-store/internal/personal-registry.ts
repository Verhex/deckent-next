import { persistedInteger, persistedUrl } from '#platform/index.js';
import { z } from 'zod';
import asset from './custody-registry.json' with { type: 'json' };
const positive = persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
export const PERSONAL_CUSTODY_REGISTRY = z.strictObject({ schemaVersion: z.literal(1), bindingFile: z.string().regex(/^[a-z][a-z0-9.-]+$/u),
  probeTimeoutMs: positive, metadataMaxBytes: positive, hostMaxBytes: positive, deviceMaxDepth: positive, filesystemTypes: z.record(z.string().min(1), positive),
  localDevicePaths: z.array(z.string().startsWith('/')).min(1), remoteDevicePatterns: z.array(z.string().startsWith('/')).min(1),
  source: persistedUrl(), observedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u) }).readonly().parse(asset);
