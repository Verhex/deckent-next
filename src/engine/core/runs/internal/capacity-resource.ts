import { z } from 'zod';
import { identitySchema } from '#domain/index.js';
import { capacityResourceKeySchema } from '#engine/core/scheduling/index.js';
/** Trusted admission metadata, never caller-selected capacity or authority. Frozen beside the Run in its create transaction. */
export const runCapacityBindingsSchema = z.array(z.strictObject({ taskId: identitySchema, resourceKey: capacityResourceKeySchema }).readonly()).readonly();
export type RunCapacityBinding = z.infer<typeof runCapacityBindingsSchema>[number];
