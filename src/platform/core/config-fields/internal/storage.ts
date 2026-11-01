import { persistedInteger } from '#platform/core/validate/index.js';
import { z } from 'zod';

/** Capability configuration, with defaults supplied only by the field registry. */
export const SQLITE_STORAGE_OPTIONS = z.strictObject({
  busyTimeoutMs: persistedInteger().nonnegative().max(2_147_483_647),
  journalMode: z.enum(['wal', 'delete']),
  durability: z.enum(['full', 'extra']),
}).readonly();
