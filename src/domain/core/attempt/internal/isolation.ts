import { z } from 'zod';
import { identitySchema } from '#domain/core/primitives/index.js';

/**
 * alpha.56 D2 (owner `invariant_now`, lead option A): what a dispatched Attempt's worker could reach, recorded by its supervisor adapter on the
 * dispatch record and checked against the created container before it starts. `network` is the realised network mode (`none`: no route at all);
 * `egress` the one channel out — `none`, or `provider-gateway` (the host CONNECT gateway to one catalog provider's model hosts). Every
 * supervisor adapter records this block; a record without it was written before it existed.
 */
export const workerIsolationSchema = z.object({ schemaVersion: z.literal(1), network: z.string().min(1).max(64),
  egress: z.discriminatedUnion('kind', [z.object({ kind: z.literal('none') }).strict(), z.object({ kind: z.literal('provider-gateway'), provider: identitySchema }).strict()]),
}).strict().readonly();
export type WorkerIsolation = z.infer<typeof workerIsolationSchema>;
/** Pure: the recorded block proves the worker reached no customer system — no network route and no egress but a provider gateway. Missing,
 * unreadable or anything wider is unproven. */
export const workerIsolationProven = (recorded: unknown) => { const parsed = workerIsolationSchema.safeParse(recorded); return parsed.success && parsed.data.network === 'none'; };
