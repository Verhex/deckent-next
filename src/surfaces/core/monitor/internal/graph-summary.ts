import { t, type Locale } from '#platform/index.js';
import type { RunView } from '#engine/index.js';
type TaskGraphSummary = NonNullable<RunView['graphSummary']>;

/** PARALLEL-S3: the DAG summary lines shared by `run inspect` and the monitor Run detail; both render the same typed engine value. */
export function renderGraphSummaryLines(summary: TaskGraphSummary, locale: Locale, ascii = false): string[] {
  const { shape, counts, criticalPath } = summary;
  return [t('monitor.graph.summary', { ...shape, ...counts }, locale),
    criticalPath.length ? t('monitor.graph.criticalPath', { length: criticalPath.length, path: criticalPath.join(ascii ? ' -> ' : ' → ') }, locale)
      : t('monitor.graph.criticalPathNone', {}, locale)];
}
