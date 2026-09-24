import { Box, Text } from 'ink';
import { useWorklinePalette } from './ink-palette-context.js';
import type { WorkLedgerEntry } from './work-ledger.js';
import { formatWorkerLine, type WorkerLineLabels } from './worker-line.js';
import { AssistantUnitRow, type AssistantRenderLabels } from './render/assistant-view.js';

export interface LedgerEntryLabels {
  readonly runCard: string;
  readonly workerCard: string;
  readonly chatUser: string;
  readonly chatAssistant: string;
  /** When present, worker cards carry the live activity line reported by the worker (as of the observation). */
  readonly workerLine?: WorkerLineLabels;
  readonly render: AssistantRenderLabels;
}

export function LedgerEntryRow({ entry, labels }: { readonly entry: WorkLedgerEntry; readonly labels: LedgerEntryLabels }) {
  const ink = useWorklinePalette();
  if (entry.kind === 'chat' && entry.role === 'assistant') {
    // A row without a unit is a complete reply: one lead unit rendered as markdown.
    return <AssistantUnitRow unit={entry.assistant ?? { kind: 'text', markdown: entry.text, lead: true }} labels={labels.render} />;
  }
  if (entry.kind === 'chat') {
    const palette = entry.role === 'user' ? ink.user : ink.assistant;
    const prefix = entry.role === 'user' ? labels.chatUser : labels.chatAssistant;
    return <Text {...palette}>{prefix}: {entry.text}</Text>;
  }
  if (entry.kind === 'notice') {
    return <Text {...(entry.level === 'error' ? ink.error : ink.muted)}>{entry.text}</Text>;
  }
  if (entry.kind === 'run') {
    return (
      <Box flexDirection="column" borderStyle="single" {...(ink.accent.color ? { borderColor: ink.accent.color } : {})} paddingX={1}>
        <Text {...ink.accent}>{labels.runCard}</Text>
        <Text {...ink.muted}>{entry.runId} · {entry.scopeId}</Text>
        <Text>rev {entry.revision}{entry.cancellationRequested ? ' · cancel' : ''}</Text>
        <Text {...ink.muted}>{entry.taskPhases}</Text>
      </Box>
    );
  }
  const live = entry.live && labels.workerLine ? formatWorkerLine(entry, labels.workerLine) : null;
  return (
    <Box flexDirection="column" borderStyle="single" {...(ink.user.color ? { borderColor: ink.user.color } : {})} paddingX={1}>
      <Text {...ink.user}>{labels.workerCard}</Text>
      <Text>{entry.taskId} · {entry.process}</Text>
      <Text {...ink.muted}>{entry.provider} · {entry.authority}</Text>
      {live ? <Text {...(live.tone === 'error' ? ink.error : live.tone === 'muted' ? ink.muted : {})}>{live.text}</Text> : null}
    </Box>
  );
}
