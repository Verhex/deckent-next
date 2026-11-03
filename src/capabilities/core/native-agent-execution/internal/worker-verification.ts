import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { identitySchema, modelReferenceSchema } from '#domain/index.js';
import { nativeAgentExecutionSchema, type NativeAgentExecution } from './contract.js';

export const nativeWorkerRefusalSchema = z.enum(['NATIVE_WORKER_TOOL_SURFACE_UNEXPECTED', 'NATIVE_WORKER_PLUGIN_UNEXPECTED']);
export type NativeWorkerRefusal = z.infer<typeof nativeWorkerRefusalSchema>;
export const nativeWorkerEvidenceTargetSchema = z.strictObject({ scopeId: identitySchema, reference: modelReferenceSchema,
  connectionId: identitySchema, execution: nativeAgentExecutionSchema }).readonly();
export type NativeWorkerEvidenceTarget = z.infer<typeof nativeWorkerEvidenceTargetSchema>;
export const nativeWorkerEvidenceSchema = z.strictObject({ schemaVersion: z.literal(1), target: nativeWorkerEvidenceTargetSchema,
  attemptId: identitySchema, checkedAtMs: z.number().int().nonnegative(), verdict: z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('verified') }), z.strictObject({ state: z.literal('refused'), reason: nativeWorkerRefusalSchema })]) }).readonly();
export type NativeWorkerEvidenceVerdict = z.infer<typeof nativeWorkerEvidenceSchema>['verdict'];
export const nativeWorkerEvidenceKey = (target: NativeWorkerEvidenceTarget) => createHash('sha256').update(JSON.stringify(nativeWorkerEvidenceTargetSchema.parse(target))).digest('hex');
export interface NativeWorkerEvidenceFile {
  read(): Promise<unknown | null>;
  claim(): Promise<null | { release(): Promise<void> }>;
  write(record: unknown): Promise<void>;
}
export class NativeWorkerVerificationError extends Error {
  constructor(readonly code: NativeWorkerRefusal | 'NATIVE_WORKER_F08_INVALID') { super(code); }
}
/** Unknown storage never becomes an unsealed first run. A known negative stays negative for this exact binding and seal. */
export async function readNativeWorkerEvidence(file: NativeWorkerEvidenceFile, target: NativeWorkerEvidenceTarget): Promise<NativeAgentExecution | null> {
  let value: unknown;
  try { value = await file.read(); } catch { throw new NativeWorkerVerificationError('NATIVE_WORKER_F08_INVALID'); }
  if (value === null) return null;
  const parsed = nativeWorkerEvidenceSchema.safeParse(value);
  if (!parsed.success || !isDeepStrictEqual(parsed.data.target, target)) throw new NativeWorkerVerificationError('NATIVE_WORKER_F08_INVALID');
  if (parsed.data.verdict.state === 'refused') throw new NativeWorkerVerificationError(parsed.data.verdict.reason);
  return parsed.data.target.execution;
}
export async function claimNativeWorkerVerification(file: NativeWorkerEvidenceFile, target: NativeWorkerEvidenceTarget, attemptId: string) {
  const claim = await file.claim(); if (!claim) return null;
  try { await readNativeWorkerEvidence(file, target); } catch (error) { await claim.release(); throw error; }
  let settled = false;
  return {
    async finish(verdict: z.infer<typeof nativeWorkerEvidenceSchema>['verdict']) {
      if (settled) return;
      await file.write(nativeWorkerEvidenceSchema.parse({ schemaVersion: 1, target, attemptId, checkedAtMs: Date.now(), verdict }));
      await claim.release(); settled = true;
    },
    async abandon() { if (!settled) { await claim.release(); settled = true; } },
  };
}
export const nativeWorkerGuardRefusal = (reason: string): NativeWorkerRefusal => reason === 'NATIVE_AGENT_PLUGIN_UNEXPECTED'
  ? 'NATIVE_WORKER_PLUGIN_UNEXPECTED' : 'NATIVE_WORKER_TOOL_SURFACE_UNEXPECTED';
