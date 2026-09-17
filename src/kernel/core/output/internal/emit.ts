import { getConfigFieldDefault } from '../../config-fields/index.js';
import type { OutputMode } from '../../common/index.js';
import { formatValue } from './format.js';
export type OutputLevel = 'info' | 'warning' | 'error' | 'critical';
export interface OutputSink { write(text: string): unknown }
export interface EmitOptions<T> {
  json?: boolean; mode?: OutputMode; level?: OutputLevel;
  render?: (data: T, mode: Exclude<OutputMode, 'json'>) => string;
  stdout?: OutputSink; stderr?: OutputSink;
}
export function createEmitter(limits: { normalBytes?: number; criticalBytes?: number } = {}) {
  let normal = 0, critical = 0;
  return function emit<T>(data: T, options: EmitOptions<T> = {}): boolean {
    const mode = options.mode ?? getConfigFieldDefault('output_mode');
    const text = `${(options.json || mode === 'json') ? JSON.stringify(data) : options.render?.(data, mode) ?? formatValue(data)}\n`;
    const bytes = Buffer.byteLength(text);
    const priority = options.level === 'critical';
    // Never truncate a JSON document or make critical diagnostics compete with ordinary output.
    if (priority ? critical + bytes > (limits.criticalBytes ?? Infinity) : normal + bytes > (limits.normalBytes ?? Infinity)) return false;
    if (priority) critical += bytes; else normal += bytes;
    const sink = options.level && options.level !== 'info' ? options.stderr ?? process.stderr : options.stdout ?? process.stdout;
    sink.write(text);
    return true;
  };
}
export const emit = createEmitter();
