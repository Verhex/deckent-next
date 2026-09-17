import { z } from 'zod';

/** Capability configuration, with defaults supplied only by the field registry. */
export const SQLITE_STORAGE_OPTIONS = z.object({
  busyTimeoutMs: z.number().int().nonnegative().max(2_147_483_647),
  journalMode: z.enum(['wal', 'delete']),
  durability: z.enum(['full', 'extra']),
}).strict().readonly();
