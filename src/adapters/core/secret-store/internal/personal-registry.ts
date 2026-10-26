import { z } from 'zod';
import asset from './custody-registry.json' with { type: 'json' };
const positive = z.number().int().positive().safe();
export const PERSONAL_CUSTODY_REGISTRY = z.object({ schemaVersion: z.literal(1), bindingFile: z.string().regex(/^[a-z][a-z0-9.-]+$/u),
  probeTimeoutMs: positive, metadataMaxBytes: positive, hostMaxBytes: positive, deviceMaxDepth: positive, filesystemTypes: z.record(z.string().min(1), positive),
  localDevicePaths: z.array(z.string().startsWith('/')).min(1), remoteDevicePatterns: z.array(z.string().startsWith('/')).min(1),
  source: z.string().url(), observedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u) }).strict().readonly().parse(asset);
