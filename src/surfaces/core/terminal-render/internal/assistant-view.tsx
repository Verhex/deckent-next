import { Box, Text, useAnimation, useWindowSize } from 'ink';
import { useWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import type { ToolResultSummary } from '#surfaces/core/terminal-kit/index.js';
import type { ActiveTool, AssistantUnit, FooterUnit, Narration, ToolUnit, TurnStage, WaitingView } from './assistant-stream.js';
import { useRenderGlyphs } from './glyphs.js';
import { RenderedLines } from './lines-view.js';
import { renderMarkdown } from './markdown.js';
import type { LiveTail } from './stream-segmenter.js';
import { fillTemplate } from './status-row.js';
import { cells, truncateEnd } from './text-width.js';

/** Catalog strings (terminal.render.*) resolved by the surface; placeholders are filled here. */
export type AssistantRenderLabels = Readonly<{
  assistant: string; thinking: string; thought: string; elapsed: string; tokens: string; reasoningTokens: string;
  truncated: string; cancelled: string; failed: string; code: string; moreAbove: string; queued: string;
  /** `{name} {target}` of a tool call; `toolRunning` adds the live seconds; statuses other than ok have their own words. */
  tool: string; toolRunning: string; toolStatus: Readonly<Record<Exclude<ToolUnit['status'], 'ok'>, string>>;
  /** Suffix word for a finished host shell call whose `cleanup` (Astra 2124) was `group-ended` or `unverified`; `clean` or an
   * absent field show nothing. Optional until the catalog carries `terminal.render.toolCleanup.*` (see `i18n-delta.json`); the
   * row falls back to short, language-neutral text meanwhile (the TERM-INTERACTIVE `@file` pattern). */
  /** S5 persistent host fallback suffix; catalog wiring is supplied in the lane i18n delta. */
  toolSandboxNone?: string;
  toolCleanup?: Readonly<Record<Exclude<NonNullable<ToolUnit['cleanup']>, 'clean'>, string>>;
  /** Result summary words for a finished read-class call (TL-B D2): `{shown}`/`{total}`/`{count}` placeholders. Optional
   * until the catalog carries `terminal.render.toolSummary.*` (see `i18n-delta.json`); the row falls back to short,
   * language-neutral text meanwhile (the same devolution `toolCleanup` used before its catalog keys were wired). */
  toolSummary?: Readonly<Record<'lines' | 'linesMore' | 'headings' | 'headingsMore' | 'matches' | 'matchesMore' | 'entries', string>>;
  /** `{percent}` of `{window}` tokens; `{approx}` is `~` when the prompt is an upper bound, not the provider's count. */
  context: string;
  /** `{count}` earlier messages were replaced by a summary to fit the context window. */
  compacted: string;
  /** TL-A (optional until the catalog carries `terminal.render.waiting.*` / `terminal.render.cancelledDuring.*`, see `i18n-delta.json`; the
   * view falls back to the neutral English text below meanwhile): the silent waits with their live `{seconds}`, and the footer word for
   * the part of the turn a cancel stopped. */
  waiting?: Readonly<Record<WaitingView['kind'], string>>;
  cancelledDuring?: Readonly<Record<TurnStage, string>>;
  /** Note under the footer when a summary was cancelled before it finished (nothing was replaced; the next turn summarizes again). */
  compactionCancelled?: string;
  /** Status row segment while a turn can be cancelled (`WorklineStatusLabels.cancelHint`). */
  cancelHint?: string;
}>;

const INDENT = 2;
const LIVE_TAIL_LINES = 8;
// Until the catalog carries `terminal.render.toolCleanup.*` the finished line falls back to short, language-neutral text
// (TERM-INTERACTIVE's `@file` notice pattern); `labels.toolCleanup` takes over once the lead wires the real catalog keys.
const NEUTRAL_TOOL_CLEANUP: NonNullable<AssistantRenderLabels['toolCleanup']> = { 'group-ended': 'cleanup: group-ended', unverified: 'cleanup: unverified' };
// TL-A: the same neutral pattern; each text equals the proposed `en` catalog value, so behavior tests hold once the lead wires the keys.
const NEUTRAL_WAITING: NonNullable<AssistantRenderLabels['waiting']> = { model: 'model is preparing a response · {seconds}s',
  compaction: 'summarizing earlier messages · {seconds}s' };
const NEUTRAL_CANCELLED_DURING: NonNullable<AssistantRenderLabels['cancelledDuring']> = { compaction: 'cancelled (summarizing)',
  model: 'cancelled (model response)', tool: 'cancelled (tool call)' };
const NEUTRAL_COMPACTION_CANCELLED = 'Summarizing was cancelled before it finished: the history is unchanged and the next turn summarizes it again.';
// Until the catalog carries `terminal.render.toolSummary.*` the finished line falls back to this short English text.
const NEUTRAL_TOOL_SUMMARY: NonNullable<AssistantRenderLabels['toolSummary']> = { lines: '{shown}/{total} lines', linesMore: '{shown}/{total} lines, more available',
  headings: '{shown}/{total} headings', headingsMore: '{shown}/{total} headings, more available', matches: '{count} matches', matchesMore: '{count}+ matches',
  entries: '{count} entries' };
const seconds = (ms: number, digits = 1) => (ms / 1000).toFixed(digits);
const tokenText = (count: number, approximate: boolean) => `${approximate ? '~' : ''}${count}`;
/** The tool line's result summary text (TL-B D2), or `null` when the finished call carries none. */
function toolSummaryText(summary: ToolResultSummary, labels: AssistantRenderLabels): string {
  const words = labels.toolSummary ?? NEUTRAL_TOOL_SUMMARY;
  switch (summary.kind) {
    case 'lines': return fillTemplate(summary.more ? words.linesMore : words.lines, { shown: summary.shown, total: summary.total });
    case 'headings': return fillTemplate(summary.more ? words.headingsMore : words.headings, { shown: summary.shown, total: summary.total });
    case 'matches': return fillTemplate(summary.more ? words.matchesMore : words.matches, { count: summary.count });
    case 'entries': return fillTemplate(words.entries, { count: summary.count });
    case 'sandbox-none': return labels.toolSandboxNone ?? 'sandbox: none';
  }
}

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
  if (unit.finish === 'cancelled') parts.push(unit.cancelledDuring ? (labels.cancelledDuring ?? NEUTRAL_CANCELLED_DURING)[unit.cancelledDuring] : labels.cancelled);
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
    // Astra 2124: a durable suffix for a shell call whose cleanup was not `clean`; `clean` or no field shows nothing.
    const cleanupWord = unit.cleanup && unit.cleanup !== 'clean' ? (labels.toolCleanup ?? NEUTRAL_TOOL_CLEANUP)[unit.cleanup] : null;
    // TL-B D2: the result summary ("12 matches", "243/269 lines") sits right after the elapsed time, before any status word.
    const tail = [fillTemplate(labels.elapsed, { seconds: seconds(unit.ms) }), ...(unit.summary ? [toolSummaryText(unit.summary, labels)] : []),
      ...(unit.status === 'ok' ? [] : [labels.toolStatus[unit.status]]), ...(cleanupWord ? [cleanupWord] : [])].join(` ${glyphs.separator} `);
    // Astra 2139 R3: the tail (elapsed, status, cleanup) keeps its place; a long command is shortened instead. When not even the tool
    // name fits beside the tail, the tail takes its own wrapped line under the (truncated) command.
    const tone = failed ? palette.error : palette.muted;
    const head = `${glyphs.separator} ${toolText(unit, labels)}`, suffix = ` ${glyphs.separator} ${tail}`;
    const room = width - cells(suffix);
    if (room >= cells(`${glyphs.separator} ${unit.name}${glyphs.ellipsis}`)) {
      return <Box paddingLeft={INDENT}><Text {...tone} wrap="truncate-end">{truncateEnd(head, room, glyphs.ellipsis)}{suffix}</Text></Box>;
    }
    return (
      <Box flexDirection="column" paddingLeft={INDENT}>
        <Text {...tone} wrap="truncate-end">{head}</Text>
        <Text {...tone} wrap="wrap">{glyphs.separator} {tail}</Text>
      </Box>
    );
  }
  if (unit.kind === 'footer') {
    return (
      <Box flexDirection="column" paddingLeft={INDENT} marginBottom={1}>
        {unit.finish === 'length' && <Text {...palette.warning}>{labels.truncated}</Text>}
        {unit.note ? <Text {...(unit.finish === 'error' ? palette.error : palette.muted)} wrap="wrap">{unit.note}</Text> : null}
        {!unit.note && unit.cancelledDuring === 'compaction' ? <Text {...palette.muted} wrap="wrap">{labels.compactionCancelled ?? NEUTRAL_COMPACTION_CANCELLED}</Text> : null}
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

/** Dim single-line reasoning narration; it only exists while reasoning streams and collapses when the answer starts. Under it, the
 * last lines of the reasoning itself (TL-A D6), dim and already sanitized; empty when the owner turned the preview off. */
export function ReasoningNarration({ narration, labels, preview = [] }: { readonly narration: Narration; readonly labels: AssistantRenderLabels;
  readonly preview?: readonly string[] }) {
  const palette = useWorklinePalette(), glyphs = useRenderGlyphs();
  const { frame } = useAnimation({ interval: 120 });
  const text = fillTemplate(labels.thinking, { tokens: tokenText(narration.tokens, narration.approximate), seconds: seconds(Date.now() - narration.startedAtMs, 0) });
  return (
    <Box flexDirection="column" paddingLeft={INDENT}>
      <Text {...palette.muted} wrap="truncate-end">{glyphs.spinner[frame % glyphs.spinner.length]} {text}</Text>
      {preview.map((line, index) => <Box key={index} paddingLeft={INDENT}><Text {...palette.muted} wrap="truncate-end">{line}</Text></Box>)}
    </Box>
  );
}

/** A silent wait with its live seconds (TL-A D1): the model preparing its answer, or the service summarizing older messages. */
function WaitingLine({ waiting, labels }: { readonly waiting: WaitingView; readonly labels: AssistantRenderLabels }) {
  const palette = useWorklinePalette(), glyphs = useRenderGlyphs();
  const { frame } = useAnimation({ interval: 120 });
  // Whole seconds waited so far (as the status row counts), never rounded up.
  const text = fillTemplate((labels.waiting ?? NEUTRAL_WAITING)[waiting.kind], { seconds: Math.floor(Math.max(0, Date.now() - waiting.sinceMs) / 1000) });
  return <Box paddingLeft={INDENT}><Text {...palette.muted} wrap="truncate-end">{glyphs.spinner[frame % glyphs.spinner.length]} {text}</Text></Box>;
}

/** The small dynamic region of a streaming answer: narration plus the unfinished tail, bounded to its last lines. */
export function AssistantLive({ tail, narration, labels, lead, activeTool = null, maxLines = LIVE_TAIL_LINES, waiting = null, reasoningPreview = [] }: {
  readonly tail: LiveTail; readonly narration: Narration | null; readonly labels: AssistantRenderLabels; readonly lead: boolean;
  readonly activeTool?: ActiveTool | null; readonly maxLines?: number;
  /** TL-A: the silent wait to show, and the reasoning preview lines (empty when hidden). */
  readonly waiting?: WaitingView | null; readonly reasoningPreview?: readonly string[];
}) {
  const palette = useWorklinePalette(), glyphs = useRenderGlyphs(), width = useBodyWidth();
  const lines = tail.markdown === '' ? [] : renderMarkdown(tail.markdown, { width, glyphs, codeLabel: labels.code });
  const hidden = Math.max(0, lines.length - maxLines);
  return (
    <Box flexDirection="column">
      {waiting && <WaitingLine waiting={waiting} labels={labels} />}
      {narration && <ReasoningNarration narration={narration} labels={labels} preview={reasoningPreview} />}
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
