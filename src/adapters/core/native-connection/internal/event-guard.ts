import type { WorkerEvent } from '#domain/index.js';
import { redactText } from './worker.js';

/**
 * Host-side export guard for worker events (Astra 2044). The container bridge scrubs best-effort, but a hostile worker
 * can POST schema-valid text directly; the gateway therefore re-applies redaction to every free-text field with the
 * credential values it projected itself plus the generic secret patterns, within the schema's own length bounds.
 */
export function scrubWorkerEvent(event: WorkerEvent, secrets: readonly string[]): WorkerEvent {
  const red = (value: string, max: number) => redactText(value, secrets, max);
  const nullable = (value: string | null, max: number) => value === null ? null : red(value, max);
  switch (event.kind) {
    case 'session.started': return { ...event, model: nullable(event.model, 128), cliVersion: nullable(event.cliVersion, 64) };
    case 'message': return { ...event, excerpt: red(event.excerpt, 240) };
    case 'tool.call': return { ...event, toolId: red(event.toolId, 96), name: red(event.name, 64), target: nullable(event.target, 256), detail: nullable(event.detail, 240) };
    case 'tool.result': return { ...event, toolId: red(event.toolId, 96) };
    case 'quota': return { ...event, window: red(event.window, 32), status: red(event.status, 32) };
    case 'limit': return { ...event, detail: red(event.detail, 120) };
    case 'session.ended': return { ...event, costBasis: nullable(event.costBasis, 32) };
    case 'unmapped': return { ...event, nativeType: red(event.nativeType, 64) };
    default: return event;
  }
}
