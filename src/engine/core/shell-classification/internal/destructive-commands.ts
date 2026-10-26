import { z } from 'zod';
import data from './destructive-commands.json' with { type: 'json' };
const word = z.string().regex(/^[a-z][a-z0-9-]*$/u);
const registry = z.object({ schemaVersion: z.literal(1), commands: z.array(z.object({ binary: word,
  arguments: z.array(word).nonempty(), reason: z.string().regex(/^shell\.destructive\.[a-z-]+$/u) }).strict()).nonempty() }).strict().parse(data);
/** Versioned defense-in-depth data; the other hard floors and compound worst-risk scanner stay in their existing owner. */
export function registeredDestructiveReason(binary: string, args: readonly string[]): string | null {
  return registry.commands.find(entry => entry.binary === binary && args.some(arg => entry.arguments.includes(arg)))?.reason ?? null;
}
