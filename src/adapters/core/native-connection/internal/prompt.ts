import { persistedString, persistedInteger } from '#domain/index.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = persistedString(z.string().min(1)).refine(value => !value.includes('\0') && Buffer.byteLength(value) <= 49152);
export const nativePromptDeliverySchema = z.strictObject({ schemaVersion: z.literal(1),
  channel: z.enum(['claude-system-prompt', 'codex-instructions-file', 'inline']), core: text, task: text,
  segments: z.array(z.strictObject({ kind: z.enum(['core', 'persona', 'skill', 'context', 'task', 'scope', 'acceptance']),
    id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/), version: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), sha256: hash,
  }).readonly()).min(4).max(29).readonly(), sha256: hash, argvSha256: hash,
}).refine(value => {
  const body = { schemaVersion: value.schemaVersion, channel: value.channel, core: value.core, task: value.task, segments: value.segments };
  return Buffer.byteLength(JSON.stringify(value)) <= 65536
    && createHash('sha256').update(JSON.stringify(body)).digest('hex') === value.sha256;
}).readonly();
