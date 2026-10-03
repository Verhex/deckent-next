import { z } from 'zod';
import type { ExecutionProfileDefinition } from '#domain/index.js';
import { nativeCliCommand, nativeCliIdSchema } from '#adapters/core/native-cli-registry/index.js';

export class NativeWorkerBindingError extends Error {
  constructor() { super('WORKER_MODEL_BINDING_MISMATCH'); this.name = 'NativeWorkerBindingError'; }
}
const pinnedSchema = z.object({ schemaVersion: z.literal(2), provider: nativeCliIdSchema, modelUsageEvidence: z.enum(['session-events', 'none']).optional(),
  model: z.object({ modelId: z.string() }).passthrough() }).passthrough();
const argvSchema = z.array(z.string()).min(1);
const same = (left: readonly string[], right: readonly string[]) => left.length === right.length && left.every((value, index) => value === right[index]);

/**
 * Astra 2197 WC-R2: the executed command of a pinned native profile (nativeSubscription v2) must be exactly the shape this adapter
 * compiles — executable and fixed arguments of the pinned provider, then only the optional segments the compiler emits (turn limit,
 * discovery, settings, core prompt channel) in order, then `<model flag> <pinned exact id> -- <prompt>` — so no second, moved, inline or
 * fallback model flag and no other executable can run under a pinned model. CLI flag knowledge stays here (commands.json), never in the
 * engine. Profiles without a v2 binding are not checked here (Run admission refuses them as unpinned).
 */
export function assertNativeWorkerBinding(profile: ExecutionProfileDefinition): void {
  const raw = (profile.parameters as Record<string, unknown>)['nativeSubscription'];
  if (!raw || typeof raw !== 'object' || (raw as { schemaVersion?: unknown }).schemaVersion !== 2) return;
  const binding = pinnedSchema.safeParse(raw), argv = argvSchema.safeParse((profile.parameters as Record<string, unknown>)['argv']);
  if (!binding.success || !argv.success) throw new NativeWorkerBindingError();
  const command = nativeCliCommand(binding.data.provider), values = argv.data, n = values.length;
  if (binding.data.modelUsageEvidence !== undefined && binding.data.modelUsageEvidence !== command.capabilities.modelUsageEvidence) throw new NativeWorkerBindingError();
  const head = [command.executable, ...command.args];
  if (n < head.length + 4 || !same(values.slice(0, head.length), head) || values[n - 4] !== command.modelFlag
    || values[n - 3] !== binding.data.model.modelId || values[n - 2] !== '--') throw new NativeWorkerBindingError();
  let rest = values.slice(head.length, n - 4);
  const take = (segment: readonly string[] | null) => { if (segment && same(rest.slice(0, segment.length), segment)) rest = rest.slice(segment.length); };
  if (command.capabilities.maxTurns && rest[0] === command.capabilities.maxTurns.flag && /^[1-9]\d{0,15}$/.test(rest[1] ?? '')) rest = rest.slice(2);
  take(command.disabledArgs);
  if (command.capabilities.settings && rest[0] === command.capabilities.settings.flag && rest.length >= 2) {
    try { const settings = JSON.parse(rest[1]!) as unknown; if (settings && typeof settings === 'object' && !Array.isArray(settings)) rest = rest.slice(2); } catch { /* not a settings segment */ }
  }
  take(command.coreArgs);
  if (rest.length > 0) throw new NativeWorkerBindingError();
}
