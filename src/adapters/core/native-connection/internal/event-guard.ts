import type { WorkerEvent } from '#domain/index.js';
import { redactBounded, type KnownSecretSnapshot } from '#platform/index.js';

/**
 * Host-side export guard for worker events (Astra 2044). The container bridge scrubs best-effort, but a hostile worker
 * can POST schema-valid text directly; the gateway therefore re-applies redaction to every free-text field with the
 * snapshot of the credential values it projected itself plus the generic secret patterns, within the schema's own length bounds.
 */
export function scrubWorkerEvent(event: WorkerEvent, known: KnownSecretSnapshot): WorkerEvent {
  const red = (value: string, max: number) => redactBounded(value, known, max);
  const nullable = (value: string | null, max: number) => value === null ? null : red(value, max);
  switch (event.kind) {
    case 'cli.observation': {
      const observation = event.observation, plugins = observation.builtinPlugins, paid = observation.paidExtraUsage;
      const names = plugins ? [...new Set(plugins.names.map(name => red(name, 256)))] : [];
      const identifier = (value: string, max: number) => { const clean = red(value, max); return /^[A-Za-z0-9_.:?-]+$/u.test(clean) ? clean : '?'; };
      return { ...event, observation: { ...observation, cliVersion: nullable(observation.cliVersion, 64),
        builtinPlugins: plugins ? { names, omitted: plugins.omitted + plugins.names.length - names.length } : null,
        paidExtraUsage: paid ? { ...paid, status: identifier(paid.status, 16), window: identifier(paid.window, 24) } : null } };
    }
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
