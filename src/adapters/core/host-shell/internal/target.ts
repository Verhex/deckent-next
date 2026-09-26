import { z } from 'zod';
import type { AgentToolSpec } from '#domain/index.js';
import { EffectTargetError, type EffectApplyRequest, type EffectTarget } from '#engine/index.js';
import { runHostShell, type HostShellResult } from './run.js';

export const HOST_SHELL_TARGET_KIND = 'host-shell';
/** Core operation of an agent shell command (catalog data in code for the built-in Core target). Policy-gated: which commands ask is
 * the tool's classification (read-only / modify / destructive), never this descriptor. */
export const HOST_SHELL_RUN_OPERATION = Object.freeze({ schemaVersion: 1 as const, operation: Object.freeze({ id: 'host.shell.run', version: 1 }),
  targetKind: HOST_SHELL_TARGET_KIND, effectClass: 'write' as const, approval: 'policy' as const, precondition: 'none' as const,
  compensation: null, inputMaxBytes: 65_536 });
/** Longest command the tool accepts. */
export const HOST_SHELL_COMMAND_MAX_CHARS = 16_384;

export const RUN_SHELL_TOOL_SPEC: AgentToolSpec = Object.freeze({ name: 'run_shell', version: 1, toolClass: 'shell' as const,
  description: 'Run a bash command in the project root on the user\'s machine and return its output (not a sandbox: it runs as the user). '
    + 'Read-only commands (ls, cat, grep on named files, git status/diff/log) may run without asking; anything that changes files or state, '
    + 'traverses the whole tree, or is destructive is shown to the owner first. No interactive input; long output is shortened.',
  inputSchema: { type: 'object' as const, required: ['command'], properties: { command: { type: 'string', description: 'The bash command line' } } } });

const inputSchema = z.object({ command: z.string().min(1).max(HOST_SHELL_COMMAND_MAX_CHARS) }).strict();

/**
 * The host shell as a C11 effect target (T-L4 slice 3c). Each run is its own record (the caller derives the record id from the
 * command id), so an uncertain run never blocks later ones. A shell keeps no idempotency record: after a crash the outcome of a
 * started command cannot be known, so `lookup` is always unknown and a resume never runs it again. A command that exited is the
 * effect (whatever its exit code); a cancelled or timed-out one is unknown (it may have changed things before it was stopped);
 * one that could not start was refused (nothing ran). The run's result is handed to `onResult` for the tool's answer.
 */
export class HostShellTarget implements EffectTarget {
  readonly kind = HOST_SHELL_TARGET_KIND;
  constructor(private readonly cwd: string, private readonly run: { readonly timeoutMs: number; readonly extraEnv: readonly string[];
    readonly signal: AbortSignal; readonly onOutput: (stream: 'stdout' | 'stderr', text: string) => void; readonly onResult: (result: HostShellResult) => void }) {}
  identity() { return `host-shell:${this.cwd}`; }
  async observe() { return { version: null }; }
  async apply(request: EffectApplyRequest) {
    const parsed = inputSchema.safeParse(request.input);
    if (!parsed.success) throw new EffectTargetError('EFFECT_TARGET_REJECTED');
    const result = await runHostShell({ command: parsed.data.command, cwd: this.cwd, timeoutMs: this.run.timeoutMs, extraEnv: this.run.extraEnv,
      signal: this.run.signal, onOutput: this.run.onOutput });
    this.run.onResult(result);
    if (result.status === 'exited') return { version: null };
    if (result.status === 'spawn-failed' || result.status === 'unsupported-platform') throw new EffectTargetError('EFFECT_TARGET_REJECTED');
    throw new EffectTargetError('EFFECT_TARGET_UNKNOWN');
  }
  async lookup() { return null; }
}
