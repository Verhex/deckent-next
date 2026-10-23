import { createHash } from 'node:crypto';
import { z } from 'zod';
import { memoryTemplate, workerReportLimits } from '#domain/index.js';
import core from './worker-core.json' with { type: 'json' };
import limits from './prompt-limits.json' with { type: 'json' };
export const NATIVE_PROMPT_LIMITS /* data; the agent catalog's define-time bound (S8-1a) */ = Object.freeze({ ...limits });

const text = z.string().min(1).refine(value => value.trim().length > 0 && !value.includes('\0') && Buffer.byteLength(value) <= 16384);
/** One explicitly selected, versioned prompt part (core, persona, skill or context). */
export const promptPartSchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/), version: z.number().int().positive().safe(), text }).strict().readonly();
export const nativePromptCompositionSchema = z.object({ schemaVersion: z.literal(1), core: promptPartSchema.optional(),
  persona: promptPartSchema.optional(), skills: z.array(promptPartSchema).max(16).default([]), context: z.array(promptPartSchema).max(8).default([]),
  task: text, scope: text, acceptance: text,
}).strict().superRefine((value, ctx) => {
  const ids = [...(value.persona ? [value.persona.id] : []), ...value.skills.map(p => p.id)];
  if (new Set(ids).size !== ids.length || new Set(value.context.map(p => p.id)).size !== value.context.length)
    ctx.addIssue({ code: 'custom', message: 'Duplicate prompt selection' });
  if (Buffer.byteLength(JSON.stringify(value)) > limits.compositionMaxBytes) ctx.addIssue({ code: 'custom', message: 'Prompt composition too large' });
}).readonly();
export const promptHash = (value: string) => createHash('sha256').update(value).digest('hex');

/** S4B-2 (§4.4): the one worker instruction sentence for the optional report `lessons` claim. The text is the versioned `memory-templates` row; its
 * `id@version` heads the appended paragraph, so the sealed core segment digest covers the template identity and the rendered bound (never a literal in
 * the sentence). It rides the core part, not a context slot: the template's own (at most 8) context parts and the project instructions keep their room. */
const REPORT_LESSONS_TEMPLATE = { id: 'report-lessons', version: 1 } as const;
const withReportLessons = (part: z.infer<typeof promptPartSchema>): z.infer<typeof promptPartSchema> => {
  const { id, version } = REPORT_LESSONS_TEMPLATE, header = `### ${id}@${version}`;
  return part.text.includes(header) ? part : { ...part, text: `${part.text}\n\n${header}\n${memoryTemplate(id, version).replace('{max}', String(workerReportLimits.lessons))}` };
};

/** Explicit selected content only. No repository discovery, catalog lookup, routing or permission grant. */
export function composeNativePrompt(input: z.infer<typeof nativePromptCompositionSchema>, channel: string) {
  const selections = [
    { kind: 'core', ...withReportLessons(input.core ?? core) },
    ...(input.persona ? [{ kind: 'persona', ...input.persona }] : []),
    ...input.skills.map(p => ({ kind: 'skill', ...p })), ...input.context.map(p => ({ kind: 'context', ...p })),
    ...(['task', 'scope', 'acceptance'] as const).map(kind => ({ kind, id: kind, version: 1, text: input[kind] })),
  ];
  const rendered = selections.map(p => `### ${p.kind}:${p.id}@${p.version}\n${p.text}`);
  const body = { schemaVersion: 1 as const, channel, core: rendered[0]!, task: rendered.slice(1).join('\n\n'),
    segments: selections.map((p, i) => ({ kind: p.kind, id: p.id, version: p.version, sha256: promptHash(rendered[i]!) })) };
  return { ...body, sha256: promptHash(JSON.stringify(body)) };
}
