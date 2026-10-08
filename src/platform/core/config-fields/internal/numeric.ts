import type { ConfigChoiceDeclaration, ConfigNumberUnit } from './choices.js';
export type ConfigStepper = Readonly<{ min: number; max: number; step: number; unit: ConfigNumberUnit; current: number }>;
export function numericSchema(schema: unknown): Record<string, unknown> | null {
  if (!schema || typeof schema !== 'object') return null;
  const s = schema as Record<string, unknown>;
  if (s['type'] === 'number' || s['type'] === 'integer') return s;
  const options = s['anyOf'] ?? s['oneOf'];
  return Array.isArray(options) ? options.map(numericSchema).find(Boolean) ?? null : null;
}
export function configStepper(schema: unknown, declaration: ConfigChoiceDeclaration | undefined, value: unknown): ConfigStepper | null {
  if (declaration?.kind !== 'numeric') return null;
  const s = numericSchema(schema); if (!s) return null;
  const integer = s['type'] === 'integer', quantum = integer ? 1 : declaration.step;
  const min = Math.max(typeof s['minimum'] === 'number' ? s['minimum'] + (s['exclusiveMinimum'] === true ? quantum : 0) : -Number.MAX_SAFE_INTEGER,
    typeof s['exclusiveMinimum'] === 'number' ? s['exclusiveMinimum'] + quantum : -Number.MAX_SAFE_INTEGER);
  const max = Math.min(typeof s['maximum'] === 'number' ? s['maximum'] - (s['exclusiveMaximum'] === true ? quantum : 0) : Number.MAX_SAFE_INTEGER,
    typeof s['exclusiveMaximum'] === 'number' ? s['exclusiveMaximum'] - quantum : Number.MAX_SAFE_INTEGER);
  const fallback = typeof s['default'] === 'number' ? s['default'] : declaration.presets.find(n => n >= min && n <= max) ?? min;
  return { min, max, step: declaration.step, unit: declaration.unit, current: Math.min(max, Math.max(min, typeof value === 'number' ? value : fallback)) };
}
export function stepConfigNumber(stepper: ConfigStepper, value: number, direction: -1 | 1): number {
  return Math.min(stepper.max, Math.max(stepper.min, Number((value + direction * stepper.step).toFixed(stepper.step.toString().split('.')[1]?.length ?? 0))));
}
export function configNumberText(value: number, unit: ConfigNumberUnit): string {
  if (unit === 'ms') { for (const [factor, name] of [[86400000, 'd'], [3600000, 'h'], [60000, 'min'], [1000, 's']] as const) if (value !== 0 && value % factor === 0) return `${value / factor} ${name}`; return `${value} ms`; }
  if (unit === 'bytes' || unit === 'KiB') { const bytes = unit === 'KiB' ? value * 1024 : value; for (const [factor, name] of [[1073741824, 'GB'], [1048576, 'MB'], [1024, 'KB']] as const) if (bytes !== 0 && bytes % factor === 0) return `${bytes / factor} ${name}`; return `${bytes} B`; }
  return unit === 'days' ? `${value} d` : String(value);
}
