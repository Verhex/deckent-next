import { z } from 'zod';
import { attemptIdentitySchema, sameAttemptIdentity } from '#domain/index.js';
import { artifactReceiptSchema, type ArtifactStore } from '#capabilities/index.js';
import { collectedOutputFileSchema, outputFileNameSchema, outputFileFailureSchema, type CollectedOutputFile } from '#engine/core/supervisor/index.js';
import type { SandboxRequest, SandboxResult } from '#engine/core/supervisor/index.js';
import { DispatchError, type DispatchRecord } from './port.js';
const retainedFileSchema = z.discriminatedUnion('status', [
  z.object({ name: outputFileNameSchema, status: z.literal('collected'), receipt: artifactReceiptSchema }).strict(),
  z.object({ name: outputFileNameSchema, status: z.literal('unavailable'), reason: outputFileFailureSchema }).strict(),
]);
const outputSchema = z.object({ schemaVersion: z.literal(1), identity: attemptIdentitySchema,
  completeness: z.enum(['complete', 'partial', 'unavailable']), stdout: z.string(), stderr: z.string(),
  files: z.array(retainedFileSchema).optional() }).strict();
export function parseRetainedOutputEnvelope(bytes: Uint8Array, identity: unknown) {
  const expected = attemptIdentitySchema.safeParse(identity); let output;
  try { output = outputSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
  catch { throw new DispatchError('DISPATCH_ARTIFACT_REQUIRED'); }
  if (!expected.success || !sameAttemptIdentity(output.identity, expected.data)) {
    throw new DispatchError('DISPATCH_ARTIFACT_REQUIRED');
  }
  if (new Set(output.files?.map(file => file.name)).size !== (output.files?.length ?? 0)
    || output.files?.some(file => file.status === 'collected' && file.receipt.scopeId !== expected.data.scopeId)) {
    throw new DispatchError('DISPATCH_ARTIFACT_REQUIRED');
  }
  return output;
}
/** Acceptance and resource release still require complete evidence, including on recovery replay. */
export function verifyRetainedOutputEnvelope(bytes: Uint8Array, identity: unknown) {
  const output = parseRetainedOutputEnvelope(bytes, identity);
  if (output.completeness !== 'complete' || output.files?.some(file => file.status !== 'collected')) throw new DispatchError('DISPATCH_ARTIFACT_REQUIRED');
  return output;
}
async function retainFiles(store: ArtifactStore, request: SandboxRequest, input: readonly CollectedOutputFile[]) {
  const files = []; const names = new Set<string>();
  for (const value of input) {
    const file = collectedOutputFileSchema.parse(value);
    if (names.has(file.name)) throw new DispatchError('DISPATCH_ARTIFACT_REQUIRED');
    names.add(file.name);
    files.push(file.status === 'collected' ? { name: file.name, status: file.status, receipt: await store.put(request.identity.scopeId, file.bytes) } : file);
  }
  return files.length ? { files } : {};
}
export async function verifyRetainedFileReceipts(store: Pick<ArtifactStore, 'read'>, output: ReturnType<typeof verifyRetainedOutputEnvelope>) {
  for (const file of output.files ?? []) {
    if (file.status !== 'collected') throw new DispatchError('DISPATCH_ARTIFACT_REQUIRED');
    await store.read(output.identity.scopeId, file.receipt);
  }
}
export async function retainRecoveredOutput(store: ArtifactStore, request: SandboxRequest, output: { stdout: string; stderr: string }, files: readonly CollectedOutputFile[] = []) {
  const envelope = outputSchema.parse({ schemaVersion: 1, identity: request.identity, completeness: 'partial', ...output, ...await retainFiles(store, request, files) });
  return store.put(request.identity.scopeId, new TextEncoder().encode(JSON.stringify(envelope)));
}
export async function retainOutput(store: ArtifactStore, request: SandboxRequest, result: SandboxResult, files: readonly CollectedOutputFile[] = []) {
  const output = outputSchema.parse({ schemaVersion: 1, identity: request.identity,
    completeness: files.some(file => file.status !== 'collected') ? 'partial' : result.outputCompleteness,
    stdout: result.stdout, stderr: result.stderr, ...await retainFiles(store, request, files) });
  return store.put(request.identity.scopeId, new TextEncoder().encode(JSON.stringify(output)));
}
export async function verifyRetainedOutput(store: ArtifactStore, record: DispatchRecord): Promise<void> {
  if (!record.output) throw new DispatchError('DISPATCH_ARTIFACT_REQUIRED');
  const bytes = await store.read(record.request.identity.scopeId, record.output);
  await verifyRetainedFileReceipts(store, verifyRetainedOutputEnvelope(bytes, record.request.identity));
}
