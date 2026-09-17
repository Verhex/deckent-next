import { redactSensitive } from '#platform/core/errors/index.js';
import type { ResolvedConfig } from './layers.js';

/** Mask provenance before selecting a subtree; never redact serialized JSON syntax. */
export function configDisplayView(config: ResolvedConfig): Record<string, unknown> {
  const paths = new Set(config.secretPaths);
  function visit(value: unknown, path: string, key = ''): unknown {
    if (paths.has(path) || /password|passwd|token|secret|api[_-]?key|private[_-]?key/i.test(key)) return '[REDACTED]';
    if (typeof value === 'string') return redactSensitive(value);
    if (Array.isArray(value)) return value.map((child, i) => visit(child, `${path}/${i}`));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, child]) =>
      [name, visit(child, `${path}/${name.replace(/~/g, '~0').replace(/\//g, '~1')}`, name)]));
    return value;
  }
  const visible = Object.fromEntries(Object.entries(config).filter(([key]) => key !== 'secretPaths'));
  return visit(visible, '') as Record<string, unknown>;
}
