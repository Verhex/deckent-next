import { z } from 'zod';
import data from './reservation-policy.json' with { type: 'json' };
export const OPENAI_RESERVATION_POLICY = z.object({ schemaVersion: z.literal(1), expectedServiceTier: z.union([z.literal('default'), z.literal('flex'), z.literal('priority')]),
  safetyMarginPercent: z.number().int().nonnegative().safe(), note: z.string() }).strict().parse(data);
