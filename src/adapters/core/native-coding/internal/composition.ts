import { createHash } from 'node:crypto';
import { z } from 'zod';
import core from './worker-core.json' with { type: 'json' };

const text = z.string().min(1).refine(value => value.trim().length > 0 && !value.includes('\0') && Buffer.byteLength(value) <= 16384);
const part = z.object({ id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/), version: z.number().int().positive().safe(), text }).strict().readonly();
export const nativePromptCompositionSchema = z.object({ schemaVersion: z.literal(1), core: part.optional(),
  persona: part.optional(), skills: z.array(part).max(16).default([]), context: z.array(part).max(8).default([]),
  task: text, scope: text, acceptance: text,
}).strict().superRefine((value, ctx) => {
  const ids = [...(value.persona ? [value.persona.id] : []), ...value.skills.map(p => p.id)];
  if (new Set(ids).size !== ids.length || new Set(value.context.map(p => p.id)).size !== value.context.length)
    ctx.addIssue({ code: 'custom', message: 'Duplicate prompt selection' });
  if (Buffer.byteLength(JSON.stringify(value)) > 32768) ctx.addIssue({ code: 'custom', message: 'Prompt composition too large' });
}).readonly();
export const promptHash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Explicit selected content only. No repository discovery, catalog lookup, routing or permission grant. */
export function composeNativePrompt(input: z.infer<typeof nativePromptCompositionSchema>, channel: string) {
  const selections = [
    { kind: 'core', ...(input.core ?? core) },
    ...(input.persona ? [{ kind: 'persona', ...input.persona }] : []),
    ...input.skills.map(p => ({ kind: 'skill', ...p })), ...input.context.map(p => ({ kind: 'context', ...p })),
    ...(['task', 'scope', 'acceptance'] as const).map(kind => ({ kind, id: kind, version: 1, text: input[kind] })),
  ];
  const rendered = selections.map(p => `### ${p.kind}:${p.id}@${p.version}\n${p.text}`);
  const body = { schemaVersion: 1 as const, channel, core: rendered[0]!, task: rendered.slice(1).join('\n\n'),
    segments: selections.map((p, i) => ({ kind: p.kind, id: p.id, version: p.version, sha256: promptHash(rendered[i]!) })) };
  return { ...body, sha256: promptHash(JSON.stringify(body)) };
}
