import { getConfigFieldDefault } from '#platform/core/config-fields/index.js';
import type { OutputMode } from '#platform/core/common/index.js';
import { t, resolveLocale, type Locale } from '#platform/core/i18n/index.js';
import { stripAnsi } from './color.js';
export function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2) ?? 'null';
}
export function formatTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((h, i) => Math.max(stripAnsi(h).length, ...rows.map(row => stripAnsi(row[i] ?? '').length)));
  return [headers, ...rows].map(row => headers.map((_, i) => {
    const cell = row[i] ?? ''; return cell + ' '.repeat(widths[i]! - stripAnsi(cell).length);
  }).join('  ').trimEnd()).join('\n');
}
export interface StatusData { status?: string; phase?: string; completedTasks?: number; totalTasks?: number; activeWorkers?: number; liveRows?: readonly string[]; memory?: { state: 'known'; count: number } | { state: 'unknown' } }
export function formatStatus(data: StatusData, mode: OutputMode = getConfigFieldDefault('output_mode'), locale: Locale = resolveLocale()): string {
  const terminal = data.status === 'COMPLETE' || data.phase === 'COMPLETE';
  const safe = { ...data, activeWorkers: terminal ? 0 : data.activeWorkers ?? 0, liveRows: terminal ? [] : data.liveRows ?? [] };
  if (mode === 'json') return JSON.stringify(safe);
  const summary = t('output.status', { phase: safe.phase ?? safe.status ?? t('output.unknown', {}, locale), completed: safe.completedTasks ?? 0, total: safe.totalTasks ?? 0, workers: safe.activeWorkers }, locale);
  const memory = data.memory?.state === 'known' ? String(data.memory.count) : t('output.unknown', {}, locale);
  return [summary, ...safe.liveRows, ...(mode === 'standard' ? [] : [t('output.details', { value: memory }, locale)])].join('\n');
}
export async function readMemoryKnowledge(read: () => Promise<number>): Promise<{ state: 'known'; count: number } | { state: 'unknown' }> {
  try { const count = await read(); return Number.isSafeInteger(count) && count >= 0 ? { state: 'known', count } : { state: 'unknown' }; }
  catch { return { state: 'unknown' }; }
}
