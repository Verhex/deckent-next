import { z } from 'zod';
/** One terminal Docker observation, whitelisted and bounded. Stored inside the exact attempt's existing dispatch row;
 * no commands, mounts, environment, endpoint or secret material. Daemon times preserve nanoseconds for measurement joins. */
const time = z.string().max(40).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/).refine(value => Number.isFinite(Date.parse(value)) && !value.startsWith('0001-'));
const positive = z.number().int().positive().safe();
export const containerEvidenceSchema = z.object({ schemaVersion: z.literal(1), containerId: z.string().regex(/^[a-f0-9]{64}$/),
  imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/), startedAt: time.nullable(), finishedAt: time.nullable(),
  resources: z.object({ cpus: z.number().positive().finite(), memoryBytes: positive, pids: positive, tmpBytes: positive }).strict().readonly(),
}).strict().refine(value => value.startedAt === null || value.finishedAt === null || Date.parse(value.finishedAt) >= Date.parse(value.startedAt)).readonly();
export type ContainerEvidence = z.infer<typeof containerEvidenceSchema>;
