import { Box, Text } from 'ink';
import { useWorklinePalette } from './ink-palette-context.js';
import type { WorkLedgerWorkerEntry } from './work-ledger.js';
import { fillTemplate, formatWorkerLine, type WorkerLineLabels } from './worker-line.js';

/** Rows the live panel shows; the rest is summarized as a count (the ledger and `/workers` keep every worker). */
export const WORKER_PANEL_ROWS = 8;

export interface WorkerPanelLabels {
  readonly title: string;
  /** `+{count} more` */
  readonly more: string;
}

/**
 * Live worker panel in the dynamic (non-Static) region. It re-renders only when the single-flight worker poll or the
 * follow port delivers a new observation, so ages advance on the heartbeat and no timer of its own runs.
 */
export function WorkerPanel({ workers, labels, line }: {
  readonly workers: readonly WorkLedgerWorkerEntry[];
  readonly labels: WorkerPanelLabels;
  readonly line: WorkerLineLabels;
}) {
  const ink = useWorklinePalette();
  if (!workers.length) return null;
  const shown = workers.slice(0, WORKER_PANEL_ROWS);
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text {...ink.accent}>{labels.title}</Text>
      {shown.map(worker => {
        const row = formatWorkerLine(worker, line);
        const style = row.tone === 'error' ? ink.error : row.tone === 'muted' ? ink.muted : {};
        return <Text key={`${worker.scopeId}:${worker.taskId}:${worker.ordinal ?? 0}`} {...style}>{row.text}</Text>;
      })}
      {workers.length > shown.length ? <Text {...ink.muted}>{fillTemplate(labels.more, { count: workers.length - shown.length })}</Text> : null}
    </Box>
  );
}
