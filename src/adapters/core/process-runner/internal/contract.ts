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
export interface ProcessEvidence {
  readonly schemaVersion: 1; readonly requestId: string; readonly started: boolean;
  readonly reason: 'exit' | 'signal' | 'timeout' | 'cancelled' | 'output-limit' | 'start-failed';
  readonly exitCode: number | null; readonly signal: string | null;
  readonly stdoutBase64: string; readonly stderrBase64: string;
  readonly stdoutTruncated: boolean; readonly stderrTruncated: boolean; readonly durationMs: number;
}
export class ProcessRunnerError extends Error {
  constructor(readonly code: 'PROCESS_RUNNER_INVALID' | 'PROCESS_RUNNER_UNSUPPORTED') { super(code); this.name = 'ProcessRunnerError'; }
}
