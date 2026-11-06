import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { jsonRecordDirectory, type JsonRecordFile } from '#platform/index.js';
import { sameSandboxRequest, sandboxRequestSchema, sandboxResultSchema, SupervisorError, type ExecutionSupervisor,
  type SupervisorProfile, type SupervisorProfileSource, type SandboxRequest } from '#engine/index.js';
import { collectDockerOutputFiles } from '#adapters/core/docker-supervisor/index.js';
import { validateNativeCliWorkerSupervisorProfile } from './supervisor.js';
import { resolveNativeCliWorkerProfile } from './profile.js';

const active = new Map<string, ExecutionSupervisor & SupervisorProfileSource>();
const key = (request: SandboxRequest) => createHash('sha256').update(JSON.stringify(sandboxRequestSchema.parse(request))).digest('hex');
const recordSchema = z.strictObject({ schemaVersion: z.literal(1), request: sandboxRequestSchema, profileDigest: z.string(), result: sandboxResultSchema });
/** This record is outside the tool workspace; it contains redacted, process-confirmed output only. No PID inference or relaunch. */
export const nativeWorkerCustodyFile = (request: SandboxRequest) => jsonRecordDirectory(dirname(request.workspace))('native-worker-custody');
export function retainActiveNativeWorker(request: SandboxRequest, supervisor: ExecutionSupervisor & SupervisorProfileSource) {
  const id = key(request);
  if (active.has(id)) throw new SupervisorError('SUPERVISOR_IDENTITY_CONFLICT');
  active.set(id, supervisor);
  return () => { if (active.get(id) === supervisor) active.delete(id); };
}
export async function retainNativeWorkerResult(file: JsonRecordFile, request: SandboxRequest, profile: SupervisorProfile, result: unknown) {
  await file.write(recordSchema.parse({ schemaVersion: 1, request, profileDigest: createHash('sha256').update(JSON.stringify(profile)).digest('hex'), result }));
}
/** Same-process cancel reaches its actual owner. Restart can recover confirmed retained output; missing custody stays unknown. */
export function recordedNativeCliWorkerSupervisor(profile: SupervisorProfile): ExecutionSupervisor & SupervisorProfileSource & {
  inspectActivity(request: SandboxRequest): Promise<{ state: 'running' | 'exited' | 'unknown'; handle: string | null }>;
} {
  validateNativeCliWorkerSupervisorProfile(profile);
  const resolved = resolveNativeCliWorkerProfile(profile.parameters['task'] as import('#domain/index.js').ExecutionProfileDefinition);
  const digest = createHash('sha256').update(JSON.stringify(profile)).digest('hex');
  const read = async (request: SandboxRequest) => {
    const record = await nativeWorkerCustodyFile(request).read();
    if (record.kind !== 'ready') return null;
    const checked = recordSchema.safeParse(record.value);
    if (!checked.success || !sameSandboxRequest(checked.data.request, request) || checked.data.profileDigest !== digest) throw new SupervisorError('SUPERVISOR_IDENTITY_CONFLICT');
    return checked.data.result;
  };
  const get = async (request: SandboxRequest) => {
    const owner = active.get(key(request));
    if (owner && !isDeepStrictEqual(await owner.captureProfile(), profile)) throw new SupervisorError('SUPERVISOR_IDENTITY_CONFLICT');
    return owner;
  };
  const unknown = (request: SandboxRequest) => ({ handle: `native-cli-worker-${createHash('sha256').update(JSON.stringify(request.identity)).digest('hex')}`,
    result: { kind: 'unknown' as const, reasonCode: 'NATIVE_WORKER_CUSTODY_UNKNOWN' } });
  const observe = async (request: SandboxRequest) => {
    const owner = await get(request); if (owner) return owner.observe(request);
    const result = await read(request) ?? unknown(request); return { handle: result.handle, result: result.result };
  };
  return {
    captureProfile: async () => profile,
    async execute() { throw new SupervisorError('SUPERVISOR_REQUEST_INVALID'); },
    observe,
    async inspectActivity(request) {
      const result = await observe(request);
      return { state: result.result.kind === 'exited' ? 'exited' : 'unknown', handle: result.handle };
    },
    async cancel(request) { const owner = await get(request); return owner ? owner.cancel(request) : observe(request); },
    async recoverOutput(request) {
      const owner = await get(request); if (owner) return owner.recoverOutput(request);
      const result = await read(request); return { stdout: result?.stdout ?? '', stderr: result?.stderr ?? '', completeness: 'partial' };
    },
    async collectOutputFiles(request) {
      if ((await observe(request)).result.kind !== 'exited') throw new SupervisorError('SUPERVISOR_NOT_TERMINAL');
      return resolved.options.outputFiles ? collectDockerOutputFiles(request.workspace, resolved.options.outputFiles) : [];
    },
    async release(request) {
      const owner = await get(request); if (owner) return owner.release(request);
      if ((await observe(request)).result.kind !== 'exited') throw new SupervisorError('SUPERVISOR_RELEASE_UNCONFIRMED');
      return 'absent';
    },
  };
}
