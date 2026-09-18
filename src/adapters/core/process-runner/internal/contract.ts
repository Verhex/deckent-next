import { isAbsolute } from 'node:path';
import { z } from 'zod';
// OS argv/environment cannot represent NUL or unpaired UTF-16 surrogates losslessly.
const scalar = z.string().refine(value => !value.includes('\0') && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value));
export const processCommandSchema = z.object({ schemaVersion: z.literal(1), requestId: z.string().uuid(),
  executable: scalar.refine(isAbsolute), args: z.array(scalar).readonly(), cwd: scalar.refine(isAbsolute),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), scalar).readonly(),
  timeoutMs: z.number().int().positive().max(2_147_483_647), outputBytes: z.number().int().positive().safe(),
}).strict().readonly();
export type ProcessCommand = z.infer<typeof processCommandSchema>;
const base64 = z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
  .refine(value => Buffer.from(value, 'base64').toString('base64') === value);
export const processEvidenceSchema = z.object({ schemaVersion: z.literal(1), requestId: z.string().uuid(), started: z.boolean(),
  reason: z.enum(['exit', 'signal', 'timeout', 'cancelled', 'output-limit', 'start-failed']),
  exitCode: z.number().int().nonnegative().safe().nullable(), signal: scalar.pipe(z.string().min(1)).nullable(),
  stdoutBase64: base64, stderrBase64: base64, stdoutTruncated: z.boolean(), stderrTruncated: z.boolean(),
  durationMs: z.number().nonnegative().finite(),
}).strict().superRefine((value, context) => {
  const invalid = () => context.addIssue({ code: z.ZodIssueCode.custom, message: 'PROCESS_RUNNER_RESPONSE_INVALID' });
  if (!value.started) {
    if (!['start-failed', 'cancelled'].includes(value.reason) || value.exitCode !== null || value.signal !== null
      || value.stdoutBase64 !== '' || value.stderrBase64 !== '' || value.stdoutTruncated || value.stderrTruncated) invalid();
  } else {
    if (value.reason === 'start-failed' || (value.exitCode === null) === (value.signal === null)) invalid();
    if (value.reason === 'exit' && (value.exitCode === null || value.signal !== null)) invalid();
    if (value.reason === 'signal' && (value.exitCode !== null || value.signal === null)) invalid();
  }
  if (value.reason === 'output-limit' && !value.stdoutTruncated && !value.stderrTruncated) invalid();
  if (['exit', 'signal'].includes(value.reason) && (value.stdoutTruncated || value.stderrTruncated)) invalid();
}).readonly();
export type ProcessEvidence = z.infer<typeof processEvidenceSchema>;
/** Bounds encoded bytes before allocating decoded buffers; rejects cross-request and inconsistent evidence. */
export function validateProcessEvidence(command: ProcessCommand, input: unknown): ProcessEvidence {
  const checked = processCommandSchema.safeParse(command);
  if (!checked.success) throw new ProcessRunnerError('PROCESS_RUNNER_INVALID');
  const value = input as Partial<ProcessEvidence> | null;
  const encodedLimit = Math.ceil(checked.data.outputBytes / 3) * 4;
  if (!value || typeof value.stdoutBase64 !== 'string' || typeof value.stderrBase64 !== 'string'
    || value.stdoutBase64.length > encodedLimit || value.stderrBase64.length > encodedLimit) throw new ProcessRunnerError('PROCESS_RUNNER_RESPONSE_INVALID');
  const parsed = processEvidenceSchema.safeParse(input);
  if (!parsed.success || parsed.data.requestId !== checked.data.requestId) throw new ProcessRunnerError('PROCESS_RUNNER_RESPONSE_INVALID');
  for (const [bytes, truncated] of [[parsed.data.stdoutBase64, parsed.data.stdoutTruncated], [parsed.data.stderrBase64, parsed.data.stderrTruncated]] as const) {
    const size = Buffer.from(bytes, 'base64').length;
    if (size > checked.data.outputBytes || (truncated && size !== checked.data.outputBytes)) throw new ProcessRunnerError('PROCESS_RUNNER_RESPONSE_INVALID');
  }
  return parsed.data;
}
export class ProcessRunnerError extends Error {
  constructor(readonly code: 'PROCESS_RUNNER_INVALID' | 'PROCESS_RUNNER_UNSUPPORTED' | 'PROCESS_RUNNER_RESPONSE_INVALID') { super(code); this.name = 'ProcessRunnerError'; }
}
