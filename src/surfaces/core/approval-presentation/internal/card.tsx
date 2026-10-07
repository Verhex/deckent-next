import { useRef, useState } from 'react';
import { Box, Text, type Key } from 'ink';
import { useWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import { scopedDecisionKey, type StandingScope } from '#surfaces/core/terminal-kit/index.js';
import { HiddenTextNotice, fillTemplate, span, useRenderGlyphs, type Span } from '#surfaces/core/terminal-render/index.js';
import { Window, WINDOW_PRIORITY, type WindowLine } from '#surfaces/core/terminal-window/index.js';
import type { ApprovalDecisionProjection, ApprovalDecisionLabels, ApprovalDecisionLine } from './types.js';

export const approvalRawPatternCount = (field: ApprovalDecisionProjection) => field.patternMatches.reduce((count, match) => count + match.count, 0);

/** Each counter belongs to its original transported field, never a second display redaction pass. */
export function ApprovalDecisionWarnings({ fields, labels }: { readonly fields: readonly ApprovalDecisionProjection[]; readonly labels: ApprovalDecisionLabels }) {
  const palette = useWorklinePalette();
  return <>{fields.map((field, index) => <Box key={index} flexDirection="column">
    <HiddenTextNotice count={field.hiddenCount} label={labels.hiddenCount} />
    {labels.credentialLikeCount && approvalRawPatternCount(field) > 0
      ? <Text {...palette.warning}>{fillTemplate(labels.credentialLikeCount, { count: approvalRawPatternCount(field) })}</Text> : null}
  </Box>)}</>;
}

/** The same counters as window rows: they follow the field they belong to, in the warning role (the text carries the meaning). */
export function decisionWarningLines(fields: readonly ApprovalDecisionProjection[], labels: ApprovalDecisionLabels): WindowLine[] {
  const lines: WindowLine[] = [];
  for (const field of fields) {
    if (labels.hiddenCount && field.hiddenCount > 0) lines.push({ spans: [span(fillTemplate(labels.hiddenCount, { count: field.hiddenCount }), { role: 'warning' })] });
    const raw = approvalRawPatternCount(field);
    if (labels.credentialLikeCount && raw > 0) lines.push({ spans: [span(fillTemplate(labels.credentialLikeCount, { count: raw }), { role: 'warning' })] });
  }
  return lines;
}

/** Projected decision lines as window rows, each followed by its field warnings. */
export function decisionWindowLines(lines: readonly ApprovalDecisionLine[], labels: ApprovalDecisionLabels): WindowLine[] {
  return lines.flatMap(line => [{ ...(line.label ? { label: line.label } : {}), ...(line.exact ? { exact: true } : {}), spans: line.spans }, ...decisionWarningLines(line.fields, labels)]);
}

/** Tab opens a one-line reason the decision carries to the audit record; labels absent = no reason field. */
export type DecisionReasonLabels = Readonly<{ label: string; hint: string; empty: string }>;

export interface DecisionCardProps {
  readonly title: ApprovalDecisionLine;
  readonly projectedLines: readonly ApprovalDecisionLine[];
  readonly decisionLabels?: ApprovalDecisionLabels;
  /** The key-hint row while waiting for a decision. */
  readonly prompt: string;
  readonly pendingText: string;
  /** `{from}`, `{to}`, `{total}` when the body scrolls. */
  readonly position?: string;
  /** Right side of the title row (a live countdown). */
  readonly status?: readonly Span[];
  /** A turn's approval outranks every other window (owner 2026-10-07). */
  readonly priority?: number;
  readonly reason?: DecisionReasonLabels;
  /** Shared controller owns pending/retry when supplied; standalone cards retain their one-shot behavior. */
  readonly pending?: boolean;
  /** Standing scopes this card offers (`s` session, `a` always); none = the plain y/N card. */
  readonly scopes?: readonly StandingScope[];
  /** Called once; later keys are ignored while the decision is recorded. `reason` is the typed text, trimmed (absent: none typed). */
  readonly onDecide: (yes: boolean, standing?: StandingScope, reason?: string) => void;
}

/** Longest reason the field keeps, in UTF-16 units: the decision record's own `reason` bound (engine approval application). */
const REASON_CAP = 2048;

/**
 * Modal y/N decision in a bounded window; it owns input while it is the top window (the composer is inactive). Only a single typed `y`
 * (or an offered `s`/`a`) says yes; `n`, Enter, Esc and Ctrl+C say no. While the reason field is open every key edits the reason, so a
 * `y` typed there never decides. Shift+Tab is swallowed: under a decision it changes nothing else.
 */
export function DecisionCard({ title, projectedLines, decisionLabels = {}, prompt, pendingText, position = '{from}-{to}/{total}', status, priority = WINDOW_PRIORITY.window,
  reason: reasonLabels, pending: controlledPending, scopes = [], onDecide }: DecisionCardProps) {
  const decided = useRef(false);
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState('');
  const editingRef = useRef(false), reasonRef = useRef('');
  const edit = (open: boolean) => { editingRef.current = open; setEditing(open); };
  const write = (text: string) => {
    let kept = '';
    for (const char of text) { if (kept.length + char.length > REASON_CAP) break; kept += char; }
    reasonRef.current = kept; setReason(kept);
  };
  const onInput = (input: string, key: Key): boolean => {
    if (key.tab && key.shift) return true;
    if (editingRef.current) {
      if (key.return || key.tab || key.escape) { edit(false); return true; }
      if (key.backspace || key.delete) { write([...reasonRef.current].slice(0, -1).join('')); return true; }
      if (key.ctrl || key.meta || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.pageUp || key.pageDown || key.home || key.end) return true;
      write(reasonRef.current + input.replace(/[\r\n\t]+/gu, ' '));
      return true;
    }
    // Recording: decision keys do nothing more, scroll keys still scroll.
    if (controlledPending ?? decided.current) return key.return || key.escape || key.tab || input.length > 0 && !key.upArrow && !key.downArrow;
    if (key.tab && reasonLabels) { edit(true); return true; }
    const answer = scopedDecisionKey(input, key, scopes);
    if (answer === null) return key.tab;
    if (controlledPending === undefined) { decided.current = true; setPending(true); }
    const text = reasonRef.current.trim();
    onDecide(answer.yes, answer.standing, text || undefined);
    return true;
  };
  const reasonRow = reasonLabels && (editing || reason) ? 1 : 0;
  return <Window title={title.spans} {...(status ? { status } : {})} body={[...decisionWarningLines(title.fields, decisionLabels), ...decisionWindowLines(projectedLines, decisionLabels)]}
    hints={(controlledPending ?? pending) ? pendingText : editing && reasonLabels ? reasonLabels.hint : prompt}
    position={position} priority={priority} onInput={onInput} footerRows={reasonRow}
    {...(reasonRow ? { footer: () => <ReasonRow label={reasonLabels!.label} text={reason} editing={editing} empty={reasonLabels!.empty} /> } : {})} />;
}

function ReasonRow({ label, text, editing, empty }: { readonly label: string; readonly text: string; readonly editing: boolean; readonly empty: string }) {
  const palette = useWorklinePalette(), glyphs = useRenderGlyphs();
  return <Text wrap="truncate-start"><Text {...palette.strong}>{`${label} `}</Text>{text ? <Text>{text}</Text> : <Text {...palette.muted}>{empty}</Text>}
    {editing ? <Text {...palette.accent}>{glyphs.ascii ? '_' : '▏'}</Text> : null}</Text>;
}
