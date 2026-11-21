import { z } from 'zod';

/** Read-only setup/doctor observation, never a stored record, activation or admission decision. */
export const workerReadinessSchema = z.strictObject({ ready: z.boolean(), code: z.string(), cli: z.array(z.string()).readonly() }).readonly();
export type WorkerReadiness = z.infer<typeof workerReadinessSchema>;
