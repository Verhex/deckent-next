import { Box, Text, useAnimation, useWindowSize } from 'ink';
import { SystemTrustedClock, type TrustedClock } from '#platform/index.js';
import { useWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import type { ToolResultSummary } from '#surfaces/core/terminal-kit/index.js';
import type { ActiveTool, AssistantUnit, FooterUnit, Narration, ToolGroupStep, ToolUnit, TurnStage, WaitingView } from './assistant-stream.js';
import { useRenderGlyphs } from './glyphs.js';
import { RenderedLines } from './lines-view.js';
import { renderHumanMarkdown } from './human-text.js';
import { HiddenTextNotice, useHumanTextSecrets } from './human-text-view.js';
import type { LiveTail } from './stream-segmenter.js';
import { fillTemplate } from './status-row.js';
import { cells, truncateEnd } from './text-width.js';
import { formatContextTokens } from './token-count.js';
import TIMING from './assistant-timing.json' with { type: 'json' };

/** Catalog strings (terminal.render.*) resolved by the surface; placeholders are filled here. */
/** The human sentence for the provider refusal token in a failed round's note (the engine's `classifyProviderRejection` names), or null. */
export function providerRejectionHint(note: string | null | undefined, labels: AssistantRenderLabels): string | null {
  const token = note ? /\(([a-z]+(?:-[a-z]+)*)\)\)/.exec(note)?.[1] : undefined;
  return token && labels.providerRejection && Object.hasOwn(labels.providerRejection, token) ? labels.providerRejection[token]! : null;
}

export type AssistantRenderLabels = Readonly<{
  locale?: 'en' | 'tr';
  assistant: string; thinking: string; thought: string; elapsed: string; tokens: string; reasoningTokens: string;
  /** Catalog count for the complete transported answer projection, before live line clipping. */
  hiddenCount?: string;
  /** Informational original-field decision pattern signal; never a secret or policy verdict. */
  credentialLikeCount?: string;
  truncated: string; cancelled: string; failed: string; code: string; moreAbove: string; queued: string;
  /** SECRET-AT-REST: a human sentence per provider refusal token the engine puts in a failed round's note (`(credential-rejected)`, …). */
  providerRejection?: Readonly<Record<string, string>>;
  /** `{name} {target}` of a tool call; `toolRunning` adds the live seconds; statuses other than ok have their own words. */
  tool: string; toolRunning: string; toolStatus: Readonly<Record<Exclude<ToolUnit['status'], 'ok'>, string>>;
  /** DENY-WORDING: the status word of a call the owner declined on its card (absent: the `denied` word). */
  toolDeclined?: string;
  /** Suffix word for a finished host shell call whose `cleanup` (Astra 2124) was `group-ended` or `unverified`; `clean` or an
   * absent field show nothing. Optional until the catalog carries `terminal.render.toolCleanup.*` (see `i18n-delta.json`); the
   * row falls back to short, language-neutral text meanwhile (the TERM-INTERACTIVE `@file` pattern). */
  /** S5 persistent host fallback suffix; catalog wiring is supplied in the lane i18n delta. */
  toolSandboxNone?: string;
  toolSandboxDegraded?: string;
  toolCleanup?: Readonly<Record<Exclude<NonNullable<ToolUnit['cleanup']>, 'clean'>, string>>;
  /** FA-TRACKED-WARN: suffix of a full-access shell call that deleted or overwrote git-tracked files, `{deleted}`/`{overwritten}` placeholders,
   * shown in the warning tone (`terminal.render.toolTracked`; a label set without it falls back to the neutral en text). */
  toolTracked?: string;
  /** Result summary words for a finished read-class call (TL-B D2): `{shown}`/`{total}`/`{count}` placeholders. Optional
   * until the catalog carries `terminal.render.toolSummary.*` (see `i18n-delta.json`); the row falls back to short,
   * language-neutral text meanwhile (the same devolution `toolCleanup` used before its catalog keys were wired). */
  toolSummary?: Readonly<Record<'lines' | 'linesMore' | 'headings' | 'headingsMore' | 'matches' | 'matchesMore' | 'entries', string>>;
  /** alpha.59 L6 read group (`terminal.render.toolGroup.*`): `{count}` per kind (`…One` for exactly one), the live line's `{summary}`, and the
   * settled row's click hints. Absent: the neutral English text below. */
  toolGroup?: ToolGroupLabels;
  /** `{percent}` of `{window}` tokens; `{approx}` is `~` when the prompt is an upper bound, not the provider's count. */
  context: string;
  /** The information row's context segment before any measurement (harness gap item 1); absent: no segment until measured. */
  contextUnknown?: string;
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

export type ToolGroupLabels = Readonly<Record<'running' | 'files' | 'filesOne' | 'dirs' | 'dirsOne' | 'searches' | 'searchesOne' | 'reads' | 'readsOne' | 'expand' | 'collapse', string>>;
/** How a settled read group shows (alpha.59 L6): `collapsed`/`expanded` where a click toggles it (the full window's mouse), `open` (no pointer: the
 * summary and every call, so nothing is ever only behind a click). */
export type ToolGroupView = 'collapsed' | 'expanded' | 'open';

const INDENT = 2;
const LIVE_TAIL_LINES = 8;
const SYSTEM_CLOCK = new SystemTrustedClock();
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
// alpha.59 L6: equals the `en` catalog values of `terminal.render.toolGroup.*`.
const NEUTRAL_TOOL_GROUP: ToolGroupLabels = { running: 'Running… {summary}', files: '{count} files read', filesOne: '{count} file read', dirs: '{count} directories listed',
  dirsOne: '{count} directory listed', searches: '{count} searches', searchesOne: '{count} search', reads: '{count} other reads', readsOne: '{count} other read',
  expand: 'click to show the calls', collapse: 'click to hide the calls' };
// FA-TRACKED-WARN: equals the `en` catalog value of `terminal.render.toolTracked`.
const NEUTRAL_TOOL_TRACKED = 'tracked files: {deleted} deleted, {overwritten} overwritten';
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
    case 'sandbox-degraded': return labels.toolSandboxDegraded ?? 'sandbox: degraded';
  }
}

/** The read group's counts by kind (alpha.59 L6): a call's kind is the shape of its own result (file lines or headings, directory entries, matches);
 * a read whose result has no known shape counts as another read. Kinds with no call are left out. */
export function toolGroupSummary(steps: readonly ToolGroupStep[], labels: AssistantRenderLabels): string {
  const words = labels.toolGroup ?? NEUTRAL_TOOL_GROUP, counts = { files: 0, dirs: 0, searches: 0, reads: 0 };
  for (const step of steps) {
    if (step.kind !== 'tool') continue;
    const kind = step.summary?.kind;
    counts[kind === 'lines' || kind === 'headings' ? 'files' : kind === 'entries' ? 'dirs' : kind === 'matches' ? 'searches' : 'reads'] += 1;
  }
  return (['files', 'dirs', 'searches', 'reads'] as const).filter(kind => counts[kind] > 0)
    .map(kind => fillTemplate(counts[kind] === 1 ? words[`${kind}One`] : words[kind], { count: counts[kind] })).join(', ');
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
    percent: Math.min(999, Math.ceil(unit.context.promptTokens * 100 / unit.context.windowTokens)), window: formatContextTokens(unit.context.windowTokens, labels.locale) }));
  if (unit.finish === 'cancelled') parts.push(unit.cancelledDuring ? (labels.cancelledDuring ?? NEUTRAL_CANCELLED_DURING)[unit.cancelledDuring] : labels.cancelled);
  if (unit.finish === 'error') parts.push(labels.failed);
  return parts.join(` ${separator} `);
}

export function toolText(unit: Pick<ToolUnit, 'name' | 'target'>, labels: AssistantRenderLabels): string {
  return fillTemplate(labels.tool, { name: unit.name, target: unit.target ?? '' }).trimEnd();
}

/** One finished unit of an assistant turn, printed once by `Static` at the width current at print time. `groupView`: how a read group shows. */
export function AssistantUnitRow({ unit, labels, groupView = 'open' }: { readonly unit: AssistantUnit; readonly labels: AssistantRenderLabels; readonly groupView?: ToolGroupView }) {
  return <UnitBody unit={unit} labels={labels} groupView={groupView} width={useBodyWidth()} />;
}

/** The row itself at a measured width: a read group's calls reuse it with the group's width (one terminal-size subscription per row). */
function UnitBody({ unit, labels, groupView, width }: { readonly unit: AssistantUnit; readonly labels: AssistantRenderLabels; readonly groupView: ToolGroupView; readonly width: number }) {
  const palette = useWorklinePalette(), glyphs = useRenderGlyphs();
  const known = useHumanTextSecrets();
  if (unit.kind === 'tool-group') {
    // The Claude Code collapsed read group: one summary line; the calls under it when expanded (a click) or where no click exists.
    const ms = unit.steps.reduce((sum, step) => sum + (step.kind === 'tool' ? step.ms : 0), 0), words = labels.toolGroup ?? NEUTRAL_TOOL_GROUP;
    const hint = groupView === 'collapsed' ? words.expand : groupView === 'expanded' ? words.collapse : null;
    const head = [toolGroupSummary(unit.steps, labels), fillTemplate(labels.elapsed, { seconds: seconds(ms) }), ...(hint ? [hint] : [])].join(` ${glyphs.separator} `);
    return (
      <Box flexDirection="column">
        <Box paddingLeft={INDENT}><Text {...palette.muted} wrap="truncate-end">{glyphs.separator} {head}</Text></Box>
        {groupView === 'collapsed' ? null : unit.steps.map((step, index) => <UnitBody key={index} unit={step} labels={labels} groupView="open" width={width} />)}
      </Box>
    );
  }
  if (unit.kind === 'reasoning') {
    return <Box paddingLeft={INDENT}><Text {...palette.muted} wrap="truncate-end">{fillTemplate(labels.thought, { seconds: seconds(unit.elapsedMs), tokens: tokenText(unit.tokens, unit.approximate) })}</Text></Box>;
  }
  if (unit.kind === 'compaction') {
    return <Box paddingLeft={INDENT}><Text {...palette.muted} wrap="wrap">{glyphs.separator} {fillTemplate(labels.compacted, { count: unit.replacedMessages })}</Text></Box>;
  }
  if (unit.kind === 'tool') {
    // The owner's own decline is not a failure: it reads in the muted tone with its own word.
    const failed = unit.status !== 'ok' && unit.status !== 'duplicate' && !unit.declined;
    // Astra 2124: a durable suffix for a shell call whose cleanup was not `clean`; `clean` or no field shows nothing.
    const cleanupWord = unit.cleanup && unit.cleanup !== 'clean' ? (labels.toolCleanup ?? NEUTRAL_TOOL_CLEANUP)[unit.cleanup] : null;
    // TL-B D2: the result summary ("12 matches", "243/269 lines") sits right after the elapsed time, before any status word.
    const tail = [fillTemplate(labels.elapsed, { seconds: seconds(unit.ms) }), ...(unit.summary ? [toolSummaryText(unit.summary, labels)] : []),
      ...(unit.status === 'ok' ? [] : [unit.declined ? labels.toolDeclined ?? labels.toolStatus.denied : labels.toolStatus[unit.status]]), ...(cleanupWord ? [cleanupWord] : [])].join(` ${glyphs.separator} `);
    // Astra 2139 R3: the tail (elapsed, status, cleanup) keeps its place; a long command is shortened instead. When not even the tool
    // name fits beside the tail, the tail takes its own wrapped line under the (truncated) command.
    const tone = failed ? palette.error : palette.muted;
    const head = `${glyphs.separator} ${toolText(unit, labels)}`, suffix = ` ${glyphs.separator} ${tail}`;
    // FA-TRACKED-WARN: the durable, typed mark of tracked files a full-access call deleted or overwrote, after the tail in the warning tone.
    const trackedText = unit.trackedChanges ? fillTemplate(labels.toolTracked ?? NEUTRAL_TOOL_TRACKED, unit.trackedChanges) : null;
    const tracked = trackedText ? <Text {...palette.warning}>{` ${glyphs.separator} ${trackedText}`}</Text> : null;
    const room = width - cells(suffix) - (trackedText ? cells(` ${glyphs.separator} ${trackedText}`) : 0);
    if (room >= cells(`${glyphs.separator} ${unit.name}${glyphs.ellipsis}`)) {
      return <Box paddingLeft={INDENT}><Text {...tone} wrap="truncate-end">{truncateEnd(head, room, glyphs.ellipsis)}{suffix}{tracked}</Text></Box>;
    }
    return (
      <Box flexDirection="column" paddingLeft={INDENT}>
        <Text {...tone} wrap="truncate-end">{head}</Text>
        <Text {...tone} wrap="wrap">{glyphs.separator} {tail}{tracked}</Text>
      </Box>
    );
  }
  if (unit.kind === 'footer') {
    return (
      <Box flexDirection="column" paddingLeft={INDENT} marginBottom={1}>
        {unit.finish === 'length' && <Text {...palette.warning}>{labels.truncated}</Text>}
        {unit.finish === 'error' && providerRejectionHint(unit.note, labels) ? <Text {...palette.error} wrap="wrap">{providerRejectionHint(unit.note, labels)}</Text> : null}
        {unit.note ? <Text {...(unit.finish === 'error' ? palette.error : palette.muted)} wrap="wrap">{unit.note}</Text> : null}
        {!unit.note && unit.cancelledDuring === 'compaction' ? <Text {...palette.muted} wrap="wrap">{labels.compactionCancelled ?? NEUTRAL_COMPACTION_CANCELLED}</Text> : null}
        <Text {...(unit.finish === 'error' ? palette.error : palette.muted)} wrap="truncate-end">{footerText(unit, labels, glyphs.separator)}</Text>
      </Box>
    );
  }
  const projection = renderHumanMarkdown(unit.markdown, { width, glyphs, codeLabel: labels.code }, known);
  return (
    <Box flexDirection="column">
      {unit.lead && <Text {...palette.assistantLabel}>{glyphs.assistant} {labels.assistant}</Text>}
      <Box flexDirection="column" paddingLeft={INDENT}><RenderedLines lines={projection.lines} /><HiddenTextNotice count={projection.hiddenCount} label={labels.hiddenCount} /></Box>
    </Box>
  );
}

/** Dim single-line reasoning narration; it only exists while reasoning streams and collapses when the answer starts. Under it, the
 * last lines of the reasoning itself (TL-A D6), dim and already sanitized; empty when the owner turned the preview off. */
export function ReasoningNarration({ narration, labels, clock, preview = [] }: { readonly narration: Narration; readonly labels: AssistantRenderLabels;
  readonly clock: TrustedClock; readonly preview?: readonly string[] }) {
  const palette = useWorklinePalette(), glyphs = useRenderGlyphs();
  const { frame } = useAnimation({ interval: TIMING.spinnerIntervalMs });
  const text = fillTemplate(labels.thinking, { tokens: tokenText(narration.tokens, narration.approximate), seconds: seconds(clock.sample().wallMs - narration.startedAtMs, 0) });
  return (
    <Box flexDirection="column" paddingLeft={INDENT}>
      <Text {...palette.muted} wrap="truncate-end">{glyphs.spinner[frame % glyphs.spinner.length]} {text}</Text>
      {preview.map((line, index) => <Box key={index} paddingLeft={INDENT}><Text {...palette.muted} wrap="truncate-end">{line}</Text></Box>)}
    </Box>
  );
}

/** A silent wait with its live seconds (TL-A D1): the model preparing its answer, or the service summarizing older messages. */
function WaitingLine({ waiting, labels, clock }: { readonly waiting: WaitingView; readonly labels: AssistantRenderLabels; readonly clock: TrustedClock }) {
  const palette = useWorklinePalette(), glyphs = useRenderGlyphs();
  const { frame } = useAnimation({ interval: TIMING.spinnerIntervalMs });
  // Whole seconds waited so far (as the status row counts), never rounded up.
  const text = fillTemplate((labels.waiting ?? NEUTRAL_WAITING)[waiting.kind], { seconds: Math.floor(Math.max(0, clock.sample().wallMs - waiting.sinceMs) / TIMING.msPerSecond) });
  return <Box paddingLeft={INDENT}><Text {...palette.muted} wrap="truncate-end">{glyphs.spinner[frame % glyphs.spinner.length]} {text}</Text></Box>;
}

/** The small dynamic region of a streaming answer: narration plus the unfinished tail, bounded to its last lines. `spaceBefore`: the last
 * finished row is a tool step, so what streams now starts after one blank line, as its row will when it lands (TERM-POLISH spacing rule,
 * `stepSpaceBefore`); the running call always stands one blank line apart from what is above it. */
export function AssistantLive({ tail, narration, labels, lead, activeTool = null, maxLines = LIVE_TAIL_LINES, waiting = null, reasoningPreview = [], clock = SYSTEM_CLOCK, spaceBefore = false, toolGroup = [] }: {
  readonly tail: LiveTail; readonly narration: Narration | null; readonly labels: AssistantRenderLabels; readonly lead: boolean;
  readonly activeTool?: ActiveTool | null; readonly maxLines?: number;
  readonly clock?: TrustedClock;
  /** TL-A: the silent wait to show, and the reasoning preview lines (empty when hidden). */
  readonly waiting?: WaitingView | null; readonly reasoningPreview?: readonly string[];
  readonly spaceBefore?: boolean;
  /** alpha.59 L6: the open read group; while it is open its one live line stands for it and for the read call running in it. */
  readonly toolGroup?: readonly ToolGroupStep[];
}) {
  const palette = useWorklinePalette(), glyphs = useRenderGlyphs(), width = useBodyWidth();
  const known = useHumanTextSecrets();
  const projection = renderHumanMarkdown(tail.markdown, { width, glyphs, codeLabel: labels.code }, known);
  const lines = tail.markdown === '' ? [] : projection.lines;
  const hidden = Math.max(0, lines.length - maxLines);
  // The running call alone is a tool step: its own blank line is the one above it (never two).
  const toolOnly = activeTool !== null && !waiting && !narration && lines.length === 0 && projection.hiddenCount === 0;
  const group = toolGroup.length > 0, rest = Boolean(waiting || narration) || lines.length > 0 || projection.hiddenCount > 0;
  return (
    <Box flexDirection="column" marginTop={(spaceBefore || tail.spaceBefore) && !toolOnly && !group ? 1 : 0}>
      {group && <ToolGroupRunning steps={toolGroup} tool={activeTool} labels={labels} clock={clock} />}
      <Box flexDirection="column" marginTop={group && rest ? 1 : 0}>
        {waiting && <WaitingLine waiting={waiting} labels={labels} clock={clock} />}
        {narration && <ReasoningNarration narration={narration} labels={labels} clock={clock} preview={reasoningPreview} />}
        {lead && lines.length > 0 && <Text {...palette.assistantLabel}>{glyphs.assistant} {labels.assistant}</Text>}
        {hidden > 0 && <Box paddingLeft={INDENT}><Text {...palette.muted}>{glyphs.ellipsis} {fillTemplate(labels.moreAbove, { count: hidden })}</Text></Box>}
        {lines.length > 0 && <Box paddingLeft={INDENT}><RenderedLines lines={lines.slice(hidden)} /></Box>}
        <Box paddingLeft={INDENT}><HiddenTextNotice count={projection.hiddenCount} label={labels.hiddenCount} /></Box>
        {activeTool && !group && <ToolRunning tool={activeTool} labels={labels} clock={clock} />}
      </Box>
    </Box>
  );
}

/** The open read group's one live line: its counts so far and the read call running in it, if any (alpha.59 L6). */
function ToolGroupRunning({ steps, tool, labels, clock }: { readonly steps: readonly ToolGroupStep[]; readonly tool: ActiveTool | null; readonly labels: AssistantRenderLabels;
  readonly clock: TrustedClock }) {
  const palette = useWorklinePalette(), glyphs = useRenderGlyphs();
  const { frame } = useAnimation({ interval: TIMING.spinnerIntervalMs });
  const running = tool ? ` ${glyphs.separator} ${fillTemplate(labels.toolRunning, { tool: toolText(tool, labels), seconds: seconds(clock.sample().wallMs - tool.startedAtMs) })}` : '';
  const text = fillTemplate((labels.toolGroup ?? NEUTRAL_TOOL_GROUP).running, { summary: toolGroupSummary(steps, labels) });
  return <Box paddingLeft={INDENT} marginTop={1}><Text {...palette.muted} wrap="truncate-end">{glyphs.spinner[frame % glyphs.spinner.length]} {text}{running}</Text></Box>;
}

/** Last lines of a running call's output shown under its line (already sanitized by the stream state). */
const TOOL_OUTPUT_LINES = 3;

/** The one tool call running now, with a spinner, its live seconds and the last lines of its output. */
function ToolRunning({ tool, labels, clock }: { readonly tool: ActiveTool; readonly labels: AssistantRenderLabels; readonly clock: TrustedClock }) {
  const palette = useWorklinePalette(), glyphs = useRenderGlyphs();
  const { frame } = useAnimation({ interval: TIMING.spinnerIntervalMs });
  const text = fillTemplate(labels.toolRunning, { tool: toolText(tool, labels), seconds: seconds(clock.sample().wallMs - tool.startedAtMs) });
  const tail = tool.output.replace(/\n+$/u, '').split('\n').filter(line => line.length > 0).slice(-TOOL_OUTPUT_LINES);
  return (
    <Box flexDirection="column" paddingLeft={INDENT} marginTop={1}>
      <Text {...palette.muted} wrap="truncate-end">{glyphs.spinner[frame % glyphs.spinner.length]} {text}</Text>
      {tail.map((line, index) => <Box key={index} paddingLeft={INDENT}><Text {...palette.muted} wrap="truncate-end">{line}</Text></Box>)}
    </Box>
  );
}
