import { z } from 'zod';
import { attemptIdentitySchema, sameAttemptIdentity } from '#domain/index.js';
import type { ArtifactStore } from '#capabilities/index.js';
import type { SandboxRequest, SandboxResult } from '#engine/core/supervisor/index.js';
import { DispatchError, type DispatchRecord } from './port.js';
const outputSchema = z.object({ schemaVersion: z.literal(1), identity: attemptIdentitySchema,
  completeness: z.enum(['complete', 'partial', 'unavailable']), stdout: z.string(), stderr: z.string() }).strict();
export function parseRetainedOutputEnvelope(bytes: Uint8Array, identity: unknown) {
  const expected = attemptIdentitySchema.safeParse(identity); let output;
  try { output = outputSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
  catch { throw new DispatchError('DISPATCH_ARTIFACT_REQUIRED'); }
  if (!expected.success || !sameAttemptIdentity(output.identity, expected.data)) {
    throw new DispatchError('DISPATCH_ARTIFACT_REQUIRED');
  }
  return output;
}
/** Acceptance and resource release still require complete evidence, including on recovery replay. */
export function verifyRetainedOutputEnvelope(bytes: Uint8Array, identity: unknown) {
  const output = parseRetainedOutputEnvelope(bytes, identity);
  if (output.completeness !== 'complete') throw new DispatchError('DISPATCH_ARTIFACT_REQUIRED');
  return output;
}
export async function retainRecoveredOutput(store: ArtifactStore, request: SandboxRequest, output: { stdout: string; stderr: string }) {
  const envelope = outputSchema.parse({ schemaVersion: 1, identity: request.identity, completeness: 'partial', ...output });
  return store.put(request.identity.scopeId, new TextEncoder().encode(JSON.stringify(envelope)));
}
export async function retainOutput(store: ArtifactStore, request: SandboxRequest, result: SandboxResult) {
  const output = outputSchema.parse({ schemaVersion: 1, identity: request.identity,
    completeness: result.outputCompleteness, stdout: result.stdout, stderr: result.stderr });
  return store.put(request.identity.scopeId, new TextEncoder().encode(JSON.stringify(output)));
}
export async function verifyRetainedOutput(store: ArtifactStore, record: DispatchRecord): Promise<void> {
  if (!record.output) throw new DispatchError('DISPATCH_ARTIFACT_REQUIRED');
  const bytes = await store.read(record.request.identity.scopeId, record.output);
  verifyRetainedOutputEnvelope(bytes, record.request.identity);
}
