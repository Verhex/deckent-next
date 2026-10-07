import { Box, Text } from 'ink';
import { useWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import { type WorkLedgerEntry, formatRunCardLines, formatWorkerCardLines, formatWorkerLine, type WorkerLineLabels } from '#surfaces/core/terminal-ledger/index.js';
import { AssistantUnitRow, HumanTextRow, type AssistantRenderLabels } from '#surfaces/core/terminal-render/index.js';
import { readApprovalDecisionNotice } from './approval-decision-notice.js';
import { ApprovalDecisionNoticeRow } from './approval-decision-view.js';
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
    return <HumanTextRow text={entry.text} prefix={`${prefix}: `} style={palette} hiddenLabel={labels.render.hiddenCount} inline />;
  }
  if (entry.kind === 'notice') {
    const decision = readApprovalDecisionNotice(entry);
    if (decision) return <ApprovalDecisionNoticeRow raw={decision} labels={labels.render} error={entry.level === 'error'} />;
    return <HumanTextRow text={entry.text} style={entry.level === 'error' ? ink.error : ink.muted} hiddenLabel={labels.render.hiddenCount} />;
  }
  if (entry.kind === 'run') {
    // Words come from the card labels (catalog); without them the card shows its data only.
    const [head, revision, phases] = labels.workerLine?.card ? formatRunCardLines(entry, labels.workerLine.card) : [`${entry.runId} · ${entry.scopeId}`, `${entry.revision}`, entry.taskPhases];
    return (
      <Box flexDirection="column" borderStyle="single" {...(ink.accent.color ? { borderColor: ink.accent.color } : {})} paddingX={1}>
        <Text {...ink.accent}>{labels.runCard}</Text>
        <Text {...ink.muted}>{head}</Text>
        <Text>{revision}</Text>
        <Text {...ink.muted}>{phases}</Text>
      </Box>
    );
  }
  const live = entry.live && labels.workerLine ? formatWorkerLine(entry, labels.workerLine) : null;
  const [who, observed] = labels.workerLine ? formatWorkerCardLines(entry, labels.workerLine) : [`${entry.taskId} · ${entry.process}`, `${entry.provider} · ${entry.authority}`];
  return (
    <Box flexDirection="column" borderStyle="single" {...(ink.user.color ? { borderColor: ink.user.color } : {})} paddingX={1}>
      <Text {...ink.user}>{labels.workerCard}</Text>
      <Text>{who}</Text>
      <Text {...ink.muted}>{observed}</Text>
      {live ? <Text {...(live.tone === 'error' ? ink.error : live.tone === 'muted' ? ink.muted : {})}>{live.text}</Text> : null}
    </Box>
  );
}
