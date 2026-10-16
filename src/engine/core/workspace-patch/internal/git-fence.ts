import { createHash } from 'node:crypto';
import { z } from 'zod';
import { identitySchema } from '#domain/index.js';
import type { AdoptionFence } from './adoption.js';
export const adoptionFenceRef = (target: string) => `refs/deckent/adoption-fences/${createHash('sha256').update(target).digest('hex')}`;
/** Fixed versioned Git payload, unchanged for historical replay. Not queue authority. */
export const adoptionFenceText = (target: string, fence: AdoptionFence) => JSON.stringify({ schemaVersion: 1, kind: 'deckent-adoption-fence', target,
  sequence: fence.sequence, scopeId: fence.scopeId, commandId: fence.commandId }) + '\n';
export const adoptionFenceObjectSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('deckent-adoption-fence'), target: z.string(),
  sequence: z.number().int().positive().safe(), scopeId: identitySchema, commandId: identitySchema }).strict();
