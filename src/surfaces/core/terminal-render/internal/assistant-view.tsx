import { Box, Text, useAnimation, useWindowSize } from 'ink';
import { useWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import type { ActiveTool, AssistantUnit, FooterUnit, Narration, ToolUnit } from './assistant-stream.js';
import { useRenderGlyphs } from './glyphs.js';
import { RenderedLines } from './lines-view.js';
import { renderMarkdown } from './markdown.js';
import type { LiveTail } from './stream-segmenter.js';
import { fillTemplate } from './status-row.js';

/** Catalog strings (terminal.render.*) resolved by the surface; placeholders are filled here. */
export type AssistantRenderLabels = Readonly<{
  assistant: string; thinking: string; thought: string; elapsed: string; tokens: string; reasoningTokens: string;
  truncated: string; cancelled: string; failed: string; code: string; moreAbove: string; queued: string;
  /** `{name} {target}` of a tool call; `toolRunning` adds the live seconds; statuses other than ok have their own words. */
  tool: string; toolRunning: string; toolStatus: Readonly<Record<Exclude<ToolUnit['status'], 'ok'>, string>>;
  /** `{percent}` of `{window}` tokens; `{approx}` is `~` when the prompt is an upper bound, not the provider's count. */
  context: string;
  /** `{count}` earlier messages were replaced by a summary to fit the context window. */
  compacted: string;
}>;

const INDENT = 2;
const LIVE_TAIL_LINES = 8;
const seconds = (ms: number, digits = 1) => (ms / 1000).toFixed(digits);
const tokenText = (count: number, approximate: boolean) => `${approximate ? '~' : ''}${count}`;

function useBodyWidth(): number {
  const { columns } = useWindowSize();
  return Math.max(12, (columns || 80) - INDENT);
}

export function footerText(unit: FooterUnit, labels: AssistantRenderLabels, separator: string): string {
  const parts = [fillTemplate(labels.elapsed, { seconds: seconds(unit.elapsedMs) })];
  if (unit.promptTokens !== null && unit.completionTokens !== null) parts.push(fillTemplate(labels.tokens, { prompt: unit.promptTokens, completion: unit.completionTokens }));
  if (unit.reasoningTokens) parts.push(fillTemplate(labels.reasoningTokens, { count: unit.reasoningTokens }));
  if (unit.context?.windowTokens) parts.push(fillTemplate(labels.context, { approx: unit.context.quality === 'upper-bound' ? '~' : '',
    percent: Math.min(999, Math.ceil(unit.context.promptTokens * 100 / unit.context.windowTokens)), window: unit.context.windowTokens }));
  if (unit.finish === 'cancelled') parts.push(labels.cancelled);
  if (unit.finish === 'error') parts.push(labels.failed);
  return parts.join(` ${separator} `);
}

export function toolText(unit: Pick<ToolUnit, 'name' | 'target'>, labels: AssistantRenderLabels): string {
  return fillTemplate(labels.tool, { name: unit.name, target: unit.target ?? '' }).trimEnd();
}

/** One finished unit of an assistant turn, printed once by `Static` at the width current at print time. */
export function AssistantUnitRow({ unit, labels }: { readonly unit: AssistantUnit; readonly labels: AssistantRenderLabels }) {
  const palette = useWorklinePalette(), glyphs = useRenderGlyphs(), width = useBodyWidth();
  if (unit.kind === 'reasoning') {
    return <Box paddingLeft={INDENT}><Text {...palette.muted} wrap="truncate-end">{fillTemplate(labels.thought, { seconds: seconds(unit.elapsedMs), tokens: tokenText(unit.tokens, unit.approximate) })}</Text></Box>;
  }
  if (unit.kind === 'compaction') {
    return <Box paddingLeft={INDENT}><Text {...palette.muted} wrap="wrap">{glyphs.separator} {fillTemplate(labels.compacted, { count: unit.replacedMessages })}</Text></Box>;
  }
  if (unit.kind === 'tool') {
    const failed = unit.status !== 'ok' && unit.status !== 'duplicate';
    const tail = [fillTemplate(labels.elapsed, { seconds: seconds(unit.ms) }), ...(unit.status === 'ok' ? [] : [labels.toolStatus[unit.status]])].join(` ${glyphs.separator} `);
    return (
      <Box paddingLeft={INDENT}>
        <Text {...(failed ? palette.error : palette.muted)} wrap="truncate-end">{glyphs.separator} {toolText(unit, labels)} {glyphs.separator} {tail}</Text>
      </Box>
    );
  }
  if (unit.kind === 'footer') {
    return (
      <Box flexDirection="column" paddingLeft={INDENT} marginBottom={1}>
        {unit.finish === 'length' && <Text {...palette.warning}>{labels.truncated}</Text>}
        {unit.note ? <Text {...(unit.finish === 'error' ? palette.error : palette.muted)} wrap="wrap">{unit.note}</Text> : null}
        <Text {...(unit.finish === 'error' ? palette.error : palette.muted)} wrap="truncate-end">{footerText(unit, labels, glyphs.separator)}</Text>
      </Box>
    );
  }
  const lines = renderMarkdown(unit.markdown, { width, glyphs, codeLabel: labels.code });
  return (
    <Box flexDirection="column">
      {unit.lead && <Text {...palette.assistant} {...palette.strong}>{glyphs.assistant} {labels.assistant}</Text>}
      <Box paddingLeft={INDENT}><RenderedLines lines={lines} /></Box>
    </Box>
  );
}

/** Dim single-line reasoning narration; it only exists while reasoning streams and collapses when the answer starts. */
export function ReasoningNarration({ narration, labels }: { readonly narration: Narration; readonly labels: AssistantRenderLabels }) {
  const palette = useWorklinePalette(), glyphs = useRenderGlyphs();
  const { frame } = useAnimation({ interval: 120 });
  const text = fillTemplate(labels.thinking, { tokens: tokenText(narration.tokens, narration.approximate), seconds: seconds(Date.now() - narration.startedAtMs, 0) });
  return <Box paddingLeft={INDENT}><Text {...palette.muted} wrap="truncate-end">{glyphs.spinner[frame % glyphs.spinner.length]} {text}</Text></Box>;
}

/** The small dynamic region of a streaming answer: narration plus the unfinished tail, bounded to its last lines. */
export function AssistantLive({ tail, narration, labels, lead, activeTool = null, maxLines = LIVE_TAIL_LINES }: {
  readonly tail: LiveTail; readonly narration: Narration | null; readonly labels: AssistantRenderLabels; readonly lead: boolean;
  readonly activeTool?: ActiveTool | null; readonly maxLines?: number;
}) {
  const palette = useWorklinePalette(), glyphs = useRenderGlyphs(), width = useBodyWidth();
  const lines = tail.markdown === '' ? [] : renderMarkdown(tail.markdown, { width, glyphs, codeLabel: labels.code });
  const hidden = Math.max(0, lines.length - maxLines);
  return (
    <Box flexDirection="column">
      {narration && <ReasoningNarration narration={narration} labels={labels} />}
      {lead && lines.length > 0 && <Text {...palette.assistant} {...palette.strong}>{glyphs.assistant} {labels.assistant}</Text>}
      {hidden > 0 && <Box paddingLeft={INDENT}><Text {...palette.muted}>{glyphs.ellipsis} {fillTemplate(labels.moreAbove, { count: hidden })}</Text></Box>}
      {lines.length > 0 && <Box paddingLeft={INDENT}><RenderedLines lines={lines.slice(hidden)} /></Box>}
      {activeTool && <ToolRunning tool={activeTool} labels={labels} />}
    </Box>
  );
}

/** Last lines of a running call's output shown under its line (already sanitized by the stream state). */
const TOOL_OUTPUT_LINES = 3;

/** The one tool call running now, with a spinner, its live seconds and the last lines of its output. */
function ToolRunning({ tool, labels }: { readonly tool: ActiveTool; readonly labels: AssistantRenderLabels }) {
  const palette = useWorklinePalette(), glyphs = useRenderGlyphs();
  const { frame } = useAnimation({ interval: 120 });
  const text = fillTemplate(labels.toolRunning, { tool: toolText(tool, labels), seconds: seconds(Date.now() - tool.startedAtMs) });
  const tail = tool.output.replace(/\n+$/u, '').split('\n').filter(line => line.length > 0).slice(-TOOL_OUTPUT_LINES);
  return (
    <Box flexDirection="column" paddingLeft={INDENT}>
      <Text {...palette.muted} wrap="truncate-end">{glyphs.spinner[frame % glyphs.spinner.length]} {text}</Text>
      {tail.map((line, index) => <Box key={index} paddingLeft={INDENT}><Text {...palette.muted} wrap="truncate-end">{line}</Text></Box>)}
    </Box>
  );
}
