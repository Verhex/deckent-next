import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { counterSchema, filesystemIdentitySchema } from '#domain/index.js';
import { oauthConnectionOwnerSchema } from '#engine/core/oauth-connection/index.js';
import { persistedString, persistedUuid } from '#platform/index.js';

const inode = z.string().regex(/^[1-9]\d{0,19}$/u);
const root = z.strictObject({ canonicalRoot: persistedString(z.string().min(1)), inode, filesystemIdentity: filesystemIdentitySchema });
const installation = root.extend({ machineDigest: z.string().regex(/^[a-f0-9]{64}$/u) });
const store = root.extend({ uid: counterSchema.positive(), keyInode: inode });
const binding = z.strictObject({ schemaVersion: z.literal(2), owner: oauthConnectionOwnerSchema,
  bindingId: persistedUuid(), generation: counterSchema, cleanup: z.strictObject({ state: z.literal('complete'), revision: counterSchema }) });
const startingRecords = z.strictObject({ schemaVersion: z.literal(1), owner: oauthConnectionOwnerSchema, bindingId: persistedUuid(),
  expectedGeneration: counterSchema, installation, store });
const liveRoot = { device: z.string().regex(/^\d{1,20}$/u), local: z.literal(true) };
const observation = z.strictObject({ installation: installation.extend(liveRoot), store: store.extend(liveRoot) });

/** Isolated prototype. The caller supplies authenticated starting records and fresh, validated host evidence. */
export function decidePersonalContinuity(input: Readonly<{
  owner: z.infer<typeof oauthConnectionOwnerSchema>;
  binding: unknown;
  baseline: { status: 'verified'; record: unknown } | { status: 'missing' | 'unavailable' };
  observation: unknown;
}>): 'continue' | 'missing-start' | 'invalid-binding' | 'evidence-unavailable' | 'binding-mismatch'
  | 'generation-mismatch' | 'installation-mismatch' | 'store-mismatch' {
  if ((input.binding as { schemaVersion?: unknown } | null)?.schemaVersion === 1 || input.baseline.status === 'missing') return 'missing-start';
  const current = binding.safeParse(input.binding);
  if (!current.success) return 'invalid-binding';
  if (input.baseline.status !== 'verified') return 'evidence-unavailable';
  const start = startingRecords.safeParse(input.baseline.record), fresh = observation.safeParse(input.observation);
  if (!start.success || !fresh.success) return 'evidence-unavailable';
  if (start.data.bindingId !== current.data.bindingId || !isDeepStrictEqual(start.data.owner, input.owner)
    || !isDeepStrictEqual(current.data.owner, input.owner)) return 'binding-mismatch';
  if (start.data.expectedGeneration !== current.data.generation) return 'generation-mismatch';
  const { device: _installationDevice, local: _installationLocal, ...freshInstallation } = fresh.data.installation;
  const { device: _storeDevice, local: _storeLocal, ...freshStore } = fresh.data.store;
  if (!isDeepStrictEqual(start.data.installation, freshInstallation)) return 'installation-mismatch';
  if (!isDeepStrictEqual(start.data.store, freshStore)) return 'store-mismatch';
  return 'continue';
}
