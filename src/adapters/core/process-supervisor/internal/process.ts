import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { supervisorCommandSchema, validateSupervisorReply, SupervisorError,
  type SupervisorCommand, type SupervisorReply, type SandboxRequest, type ExecutionSupervisor } from '#engine/index.js';
const optionsSchema = z.object({ executable: z.string().min(1), args: z.array(z.string()).readonly(),
  cwd: z.string().min(1), timeoutMs: z.number().int().positive().max(2_147_483_647),
  maxInputBytes: z.number().int().positive().safe(), maxOutputBytes: z.number().int().positive().safe(),
}).strict().readonly();
export type ProcessSupervisorOptions = z.infer<typeof optionsSchema>;
/** Internal trusted worker-control subprocess; not a public execution or authorization endpoint.
 * One bounded command per process. Transport loss never proves worker termination and never retries.
 */
export class ProcessSupervisor implements ExecutionSupervisor {
  private readonly options: ProcessSupervisorOptions;
  constructor(input: ProcessSupervisorOptions) {
    const parsed = optionsSchema.safeParse(input);
    if (!parsed.success || !isAbsolute(parsed.data.executable) || !isAbsolute(parsed.data.cwd)) throw new SupervisorError('SUPERVISOR_OPTIONS_INVALID');
    this.options = parsed.data;
  }
  private async invoke(operation: SupervisorCommand['operation'], request: SandboxRequest, signal?: AbortSignal): Promise<SupervisorReply> {
    const command = supervisorCommandSchema.parse({ protocolVersion: 1, requestId: randomUUID(), operation, request });
    const input = JSON.stringify(command) + '\n';
    if (Buffer.byteLength(input) > this.options.maxInputBytes) throw new SupervisorError('SUPERVISOR_REQUEST_INVALID');
    if (signal?.aborted) throw new SupervisorError('SUPERVISOR_CANCELLED');
    const options = this.options;
    return new Promise((resolve, reject) => {
      const child = spawn(options.executable, [...options.args], { cwd: options.cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      const chunks: Buffer[] = []; let bytes = 0; let failed = false;
      // Kill the control process only. The durable application must reconcile its worker separately.
      const stop = () => { failed = true; child.kill('SIGKILL'); };
      const timeout = setTimeout(stop, options.timeoutMs);
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) stop();
      child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > options.maxOutputBytes) stop(); else chunks.push(chunk); });
      child.stderr.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > options.maxOutputBytes) stop(); });
      child.stdin.on('error', stop);
      child.on('error', () => { failed = true; });
      child.on('close', (code, exitSignal) => {
        clearTimeout(timeout); signal?.removeEventListener('abort', stop);
        if (failed || code !== 0 || exitSignal !== null) { reject(new SupervisorError('SUPERVISOR_CONTROL_FAILED')); return; }
        try {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
          resolve(validateSupervisorReply(command, JSON.parse(text)));
        } catch { reject(new SupervisorError('SUPERVISOR_CONTROL_FAILED')); }
      });
      child.stdin.end(input);
    });
  }
  async execute(request: SandboxRequest, signal?: AbortSignal) {
    const reply = await this.invoke('execute', request, signal);
    if (reply.operation !== 'execute') throw new SupervisorError('SUPERVISOR_CONTROL_FAILED');
    return reply.value;
  }
  async observe(request: SandboxRequest) {
    const reply = await this.invoke('observe', request);
    if (reply.operation !== 'observe') throw new SupervisorError('SUPERVISOR_CONTROL_FAILED');
    return reply.value;
  }
  async cancel(request: SandboxRequest) {
    const reply = await this.invoke('cancel', request);
    if (reply.operation !== 'cancel') throw new SupervisorError('SUPERVISOR_CONTROL_FAILED');
    return reply.value;
  }
  async recoverOutput(request: SandboxRequest) {
    const reply = await this.invoke('recover-output', request);
    if (reply.operation !== 'recover-output') throw new SupervisorError('SUPERVISOR_CONTROL_FAILED');
    return reply.value;
  }
  async release(request: SandboxRequest) { await this.invoke('release', request); }
}
