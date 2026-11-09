import { counterSchema } from '#domain/index.js';
import { z } from 'zod';
import data from './reservation-policy.json' with { type: 'json' };
export const OPENAI_RESERVATION_POLICY = z.strictObject({ schemaVersion: z.literal(1), expectedServiceTier: z.union([z.literal('default'), z.literal('flex'), z.literal('priority')]),
  safetyMarginPercent: counterSchema, note: z.string() }).parse(data);
