import type { NativeAgentExecution, NativeAgentReadiness, ToolSessionPort } from '#capabilities/index.js';
import type { SandboxRequest } from '#engine/index.js';
import type { WorkerEffort, WorkerEvent } from '#domain/index.js';
import type { DockerSupervisorOptions } from '#adapters/core/docker-supervisor/index.js';
import type { createNativeToolBridge, NativeToolBridgeLimits } from '#adapters/core/native-tool-bridge/index.js';
import type { NativeCliWorkerBinding } from './profile.js';

export type NativeCliWorkerWaitReason = 'NATIVE_PROJECTION_RETIRED' | 'NATIVE_WORKER_F08_REQUIRED' | 'NATIVE_WORKER_CAPACITY_WAIT'
  | 'NATIVE_WORKER_VERIFICATION_WAIT' | 'NATIVE_WORKER_F08_INVALID' | 'NATIVE_WORKER_TOOL_SURFACE_UNEXPECTED' | 'NATIVE_WORKER_PLUGIN_UNEXPECTED'
  | 'NATIVE_AGENT_CAPABILITY_UNSEALED' | 'NATIVE_AGENT_ENVIRONMENT_REFUSED' | 'NATIVE_AGENT_CLI_UNAVAILABLE'
  | 'NATIVE_AGENT_LOGIN_REQUIRED' | 'NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED' | 'NATIVE_AGENT_PLUGIN_UNEXPECTED' | 'NATIVE_AGENT_BRIDGE_UNAVAILABLE';
export type NativeCliWorkerReadiness = Readonly<{ state: 'ready'; execution: NativeAgentExecution; verification?: true } | { state: 'waiting'; reason: NativeCliWorkerWaitReason }>;
export type NativeCliWorkerProcessResult = Readonly<{ termination: 'confirmed' | 'unverified'; status: 'completed' | 'failed' | 'cancelled'; text: string;
  refusal?: import('#capabilities/index.js').NativeAgentReadinessReason }>;
/** Admitted tool-realm resources; never passed to the login-bearing CLI realm. */
export type NativeCliWorkerToolContext = Readonly<Pick<DockerSupervisorOptions, 'readOnlyMounts' | 'inputs' | 'handoffInputs'>>;
export interface NativeCliWorkerDriver {
  /** K2/K3's guarded session delegates to the supplied K1 session; no new effect owner. */
  readonly tools: ToolSessionPort;
  /** Must use the existing isolated headless runner, private login lock and bounded process owner; never host execution. */
  run(bridge: Awaited<ReturnType<typeof createNativeToolBridge>>, signal: AbortSignal): Promise<NativeCliWorkerProcessResult>;
  close(): Promise<void>;
  inspectActivity?(): Promise<Readonly<{ state: 'running' | 'exited' | 'unknown'; handle: string | null }>>;
}
export interface NativeCliWorkerPorts {
  /** Execution-only; readiness stays read-only. */ prepare?(binding: NativeCliWorkerBinding): Promise<import('#capabilities/index.js').NativeAgentReadinessReason | null>;
  readiness(binding: NativeCliWorkerBinding): Promise<NativeAgentReadiness>;
  /** Retained F08 for this exact execution seal, not a test result boolean supplied by the task. Missing/stale = null. */
  f08(binding: NativeCliWorkerBinding): Promise<NativeAgentExecution | null>;
  /** One readiness point: readiness and its F08 (for the seal readiness returned) on one K5 snapshot and one observation read. */ readinessPoint?(binding: NativeCliWorkerBinding): Promise<Readonly<{ readiness: NativeAgentReadiness; f08(execution: NativeAgentExecution): Promise<NativeAgentExecution | null> }>>;
  verification?: { acquire(request: SandboxRequest, binding: NativeCliWorkerBinding, execution: NativeAgentExecution): Promise<null | {
    finish(verdict: import('#capabilities/index.js').NativeWorkerEvidenceVerdict): Promise<void>; abandon(): Promise<void> }> };
  /** K5b: principal, installation/company, delegation, activation, lease, profile revision; on every spawn and tool admission. */
  recheck(request: SandboxRequest, binding: NativeCliWorkerBinding, signal: AbortSignal): Promise<void>;
  /** K6b owns installation-wide durable custody. A busy login is waiting, never more parallel processes. */
  capacity: { acquire(request: SandboxRequest, binding: NativeCliWorkerBinding, signal: AbortSignal): Promise<
    Readonly<{ state: 'waiting' }> | Readonly<{ state: 'acquired'; release(): Promise<void> }>> };
  /** Existing K1 effect/approval/audit owner, always AI/MCP, scoped to this exact Attempt workspace. */
  openTools(request: SandboxRequest, binding: NativeCliWorkerBinding, signal: AbortSignal, context: NativeCliWorkerToolContext): Promise<ToolSessionPort>;
  /** Probe requirements in the tool realm, never in the login realm or through the base Docker profile. */
  checkEnvironment?(request: SandboxRequest, binding: NativeCliWorkerBinding, requirements: ReturnType<typeof import('#domain/index.js').environmentRequirementsSchema.parse>,
    context: NativeCliWorkerToolContext, signal: AbortSignal): Promise<void>;
  /** Shared K2/K3 transport composition. Deliberately receives no workspace, Docker socket or task argv. */
  driver(input: Readonly<{ binding: NativeCliWorkerBinding; tools: ToolSessionPort; model: string; system: string; user: string;
    deadlineMs: number; outputBytes: number; execution: NativeAgentExecution; effort?: WorkerEffort; maxTurns?: number;
    onEvents?: (events: readonly WorkerEvent[]) => void }>, signal: AbortSignal): Promise<NativeCliWorkerDriver>;
  readonly bridgeLimits: NativeToolBridgeLimits;
}
