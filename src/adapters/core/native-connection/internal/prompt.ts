import { createHash } from 'node:crypto';
import { z } from 'zod';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().min(1).refine(value => !value.includes('\0') && Buffer.byteLength(value) <= 49152);
export const nativePromptDeliverySchema = z.object({ schemaVersion: z.literal(1),
  channel: z.enum(['claude-system-prompt', 'codex-instructions-file', 'inline']), core: text, task: text,
  segments: z.array(z.object({ kind: z.enum(['core', 'persona', 'skill', 'context', 'task', 'scope', 'acceptance']),
    id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/), version: z.number().int().positive().safe(), sha256: hash,
  }).strict().readonly()).min(4).max(29).readonly(), sha256: hash, argvSha256: hash,
}).strict().refine(value => {
  const body = { schemaVersion: value.schemaVersion, channel: value.channel, core: value.core, task: value.task, segments: value.segments };
  return Buffer.byteLength(JSON.stringify(value)) <= 65536
    && createHash('sha256').update(JSON.stringify(body)).digest('hex') === value.sha256;
}).readonly();
