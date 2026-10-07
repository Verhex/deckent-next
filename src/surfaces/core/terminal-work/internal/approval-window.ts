import { approvalTemplateLine, projectApprovalDecisionText, type ApprovalDecisionLine, type ApprovalDecisionProjection } from '#surfaces/core/approval-presentation/index.js';
import type { KnownSecretSnapshot } from '#platform/index.js';
import type { StandingScope } from '#surfaces/core/terminal-kit/index.js';
import { fillTemplate, span, sliceSpans, plainText, type Span, type SpanRole } from '#surfaces/core/terminal-render/index.js';

/**
 * T-APPROVAL-WINDOW: the labelled fields of one approval, built only from what the producer already sent (the sealed summary, the call's
 * tool and target from its `tool.started`, the bounded preview, the facts' risk cell and undo) plus the terminal's own context (project,
 * mode). Every transported value goes through the decision projection (redaction, hidden code points) before it is shown; catalog
 * templates only arrange projected spans. Raw identifiers, digests and policy cells appear only in the details section.
 */
export type ApprovalToolKind = 'shell' | 'edit' | 'write' | 'fetch' | 'mcp' | 'other';
type Fields = 'what' | 'command' | 'file' | 'address' | 'target' | 'where' | 'onBehalf' | 'scope' | 'why' | 'risk' | 'undo' | 'time' | 'preview' | 'detail';
type Details = 'id' | 'binding' | 'digest' | 'kept' | 'notKept' | 'classifier' | 'run' | 'cell' | 'compensation' | 'assurance' | 'requester' | 'engine';
export interface ApprovalWindowLabels {
  /** `{tool}`: the tool's human name; `titleUnknown` when no tool is known. */
  readonly title: string; readonly titleUnknown: string;
  readonly field: Readonly<Record<Fields, string>>;
  /** Human tool names; `mcp` and `other` take `{tool}` (and `{server}`). */
  readonly tool: Readonly<Record<ApprovalToolKind, string>>;
  /** One sentence per kind: `{path}`, `{changes}`, `{host}`, `{tool}`, `{server}`; `changes` is `{added}`/`{removed}`. */
  readonly what: Readonly<Record<ApprovalToolKind | 'changes', string>>;
  readonly where: string; readonly whereUnknown: string;
  readonly onBehalfSelf: string;
  readonly scope: string;
  /** `{rule}`, `{mode}`. */
  readonly why: string;
  /** Keyed by permission cell, plus `unknown`. */
  readonly rule: Readonly<Record<string, string>>;
  /** Keyed by permission mode, plus `unknown`. */
  readonly mode: Readonly<Record<string, string>>;
  /** Keyed by permission cell, `effect-read|write|irreversible`, plus `unknown`; `authority` is appended for an authority surface. */
  readonly risk: Readonly<Record<string, string>>;
  readonly undo: Readonly<Record<'irreversible' | 'none' | 'compensation' | 'unknown', string>>;
  /** `{clock}` m:ss left. */
  readonly time: string; readonly expired: string;
  /** An `/approvals` row whose request time is not known. */
  readonly ageUnknown: string;
  /** `{shown}`, `{total}`, `{bytes}`, `{totalBytes}`. */
  readonly previewCut: string;
  /** `{count}`: rows of a long value (a heredoc command) not shown in its field; the preview shows it whole. */
  readonly valueMore: string;
  readonly detail: Readonly<Record<Details, string>>;
  /** `{pattern}`. */
  readonly sessionCovers: string; readonly alwaysCovers: string;
  readonly keys: Readonly<Record<'once' | 'session' | 'always' | 'deny' | 'reason' | 'scroll', string>>;
  readonly reason: Readonly<{ label: string; hint: string; empty: string }>;
}

/** What the window knows of one approval (display copies only; no capability, revision or authority DTO). */
export type ApprovalWindowInput = Readonly<{
  approvalId: string; summary: string; requester: string; runId: string; taskId: string; expiresAt: number;
  tool?: string | undefined; target?: string | null | undefined; preview?: string | undefined; risk?: string | null | undefined; undo?: string | null | undefined;
  requiredAssurance?: string | undefined; assuranceLine?: ApprovalDecisionLine | null;
  standing?: Readonly<{ scopes: readonly StandingScope[]; pattern: string }> | null;
  project?: string | undefined; mode?: string | undefined;
}>;

const MCP_NAME = /^mcp__([a-z][a-z0-9]*)__(.+)$/u;
/** The sealed binding line of a tool-call approval (`agentToolApprovalSummary`: `tool · resource · digest12`, a self-source reason may follow). */
const BINDING = /^([a-z][a-z0-9_]{1,63}) · ([^\n]*) · [0-9a-f]{12}(?:\n|$)/u;
/** The call's tool and target: what the client saw (`tool.started`, or the stored subject), else the sealed binding line; null for a task. */
export function approvalCallOf(input: Pick<ApprovalWindowInput, 'tool' | 'target' | 'summary'>): Readonly<{ tool: string; target: string | null }> | null {
  if (input.tool) return { tool: input.tool, target: input.target ?? null };
  const bound = BINDING.exec(input.summary);
  return bound ? { tool: bound[1]!, target: bound[2] || null } : null;
}
export function approvalToolKind(name: string | undefined): ApprovalToolKind {
  return name === 'run_shell' ? 'shell' : name === 'edit_file' ? 'edit' : name === 'write_file' ? 'write' : name === 'fetch_url' ? 'fetch'
    : name && MCP_NAME.test(name) ? 'mcp' : 'other';
}
export function approvalToolParts(name: string | undefined): Readonly<{ tool: string; server: string }> {
  const mcp = name ? MCP_NAME.exec(name) : null;
  return { tool: mcp ? mcp[2]! : name ?? '', server: mcp ? mcp[1]! : '' };
}

/** The engine's first-line marker of a cut preview (`boundApprovalPreview`); anything else is not a marker. */
const CUT = /^\[Deckent: preview cut to (\d+) of (\d+) lines \((\d+) of (\d+) bytes\); whole text sha256 ([0-9a-f]{64})(?:; complete at (.+)|; not kept)\]$/u;
export type PreviewCut = Readonly<{ shown: number; total: number; bytes: number; totalBytes: number; digest: string; kept: string | null }>;
export function splitPreviewCut(preview: string): { readonly cut: PreviewCut | null; readonly body: string } {
  const newline = preview.indexOf('\n'), first = newline < 0 ? preview : preview.slice(0, newline), match = CUT.exec(first);
  if (!match) return { cut: null, body: preview };
  return { cut: { shown: Number(match[1]), total: Number(match[2]), bytes: Number(match[3]), totalBytes: Number(match[4]), digest: match[5]!, kept: match[6] ?? null },
    body: newline < 0 ? '' : preview.slice(newline + 1) };
}
/** Shell card preview (`$ command`, `risk: tier (reason)`, then the realm's posture): null when the text has another shape. */
export function parseShellPreview(body: string): Readonly<{ command: string; classifier: string; posture: string }> | null {
  if (!body.startsWith('$ ')) return null;
  const lines = body.split('\n'), at = lines.findIndex((line, index) => index > 0 && /^risk: \S+ \(.*\)$/u.test(line));
  if (at < 0) return null;
  return { command: lines.slice(0, at).join('\n').slice(2), classifier: lines[at]!.slice('risk: '.length), posture: lines.slice(at + 1).join('\n') };
}
/** Edit card preview: `(+A −R lines)` then the diff. */
export function parseEditPreview(body: string): Readonly<{ added: number; removed: number; diff: string }> | null {
  const match = /^\(\+(\d+) −(\d+) lines\)(?:\n|$)/u.exec(body);
  return match ? { added: Number(match[1]), removed: Number(match[2]), diff: body.slice(match[0].length) } : null;
}
/** Fetch card preview: `GET url`, `host: name…` (with the allowlist note), then the engine's notes; `rest` keeps every line after the URL. */
export function parseFetchPreview(body: string): Readonly<{ url: string; host: string; rest: string }> | null {
  const lines = body.split('\n'), get = /^GET (\S+)$/u.exec(lines[0] ?? ''), host = /^host: (\S+)/u.exec(lines[1] ?? '');
  return get && host ? { url: get[1]!, host: host[1]!, rest: lines.slice(1).join('\n') } : null;
}

/** `m:ss` (or `h:mm:ss`) left; never negative. Digits only, so no catalog text is needed. */
export function countdownClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000)), hours = Math.floor(total / 3600), minutes = Math.floor((total % 3600) / 60), seconds = total % 60;
  const ss = String(seconds).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${ss}` : `${minutes}:${ss}`;
}

/** A long value keeps the facts below it on screen: its field shows this many rows, the preview the rest (a layout constant). */
const VALUE_FIELD_ROWS = 3;

const lineOf = (spans: readonly Span[], fields: readonly ApprovalDecisionProjection[] = [], label?: string): ApprovalDecisionLine =>
  ({ spans, fields, ...(label ? { label: [span(label, { bold: true })] } : {}) });
const blank: ApprovalDecisionLine = { spans: [], fields: [] };

/** One projected text split at its newlines; its warnings stay on the first row. */
function projectedRows(field: ApprovalDecisionProjection): ApprovalDecisionLine[] {
  const parts = plainText(field.spans).split('\n'); let start = 0;
  return parts.map((part, index) => { const spans = sliceSpans(field.spans, start, start + part.length); start += part.length + 1; return { spans, fields: index === 0 ? [field] : [], exact: true }; });
}
const withRole = (spans: readonly Span[], role: SpanRole) => spans.map(part => part.role ? part : { ...part, role });
/** Common prefix/suffix of a removed/added pair: the changed middle is bold, so the change shows without colour too. */
function emphasize(spans: readonly Span[], from: number, to: number): Span[] {
  if (from >= to) return [...spans];
  const end = plainText(spans).length;
  return [...sliceSpans(spans, 0, from), ...sliceSpans(spans, from, to).map(part => ({ ...part, bold: true })), ...sliceSpans(spans, to, end)];
}
/** Diff rows keep their `+`/`-` text (NO_COLOR keeps the meaning); colour roles and the word-level emphasis are additive. */
export function diffRows(rows: readonly ApprovalDecisionLine[]): ApprovalDecisionLine[] {
  const out = rows.map(row => ({ ...row }));
  const text = (index: number) => plainText(out[index]!.spans);
  const added = (value: string) => value.startsWith('+') && !value.startsWith('+++'), removed = (value: string) => value.startsWith('-') && !value.startsWith('---');
  for (let index = 0; index < out.length; index++) {
    const value = text(index);
    if (removed(value) && index + 1 < out.length && added(text(index + 1)) && !(index + 2 < out.length && added(text(index + 2)))) {
      const a = value.slice(1), b = text(index + 1).slice(1);
      let prefix = 0; while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
      let suffix = 0; while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
      out[index] = { ...out[index]!, spans: withRole(emphasize(out[index]!.spans, 1 + prefix, 1 + a.length - suffix), 'diffRemoved') };
      out[index + 1] = { ...out[index + 1]!, spans: withRole(emphasize(out[index + 1]!.spans, 1 + prefix, 1 + b.length - suffix), 'diffAdded') };
      index++; continue;
    }
    if (added(value)) out[index] = { ...out[index]!, spans: withRole(out[index]!.spans, 'diffAdded') };
    else if (removed(value)) out[index] = { ...out[index]!, spans: withRole(out[index]!.spans, 'diffRemoved') };
    else if (value.startsWith('@@')) out[index] = { ...out[index]!, spans: withRole(out[index]!.spans, 'muted') };
  }
  return out;
}

function riskText(risk: string | null | undefined, labels: ApprovalWindowLabels): string {
  if (!risk) return labels.risk['unknown']!;
  const [head, authority] = risk.split(' · ');
  const known = labels.risk[head!] ?? labels.risk[`effect-${head}`];
  if (!known) return labels.risk['unknown']!;
  return authority && labels.risk['authority'] ? `${known} · ${labels.risk['authority']}` : known;
}
function undoText(undo: string | null | undefined, labels: ApprovalWindowLabels): string {
  return !undo ? labels.undo.unknown : undo === 'irreversible' ? labels.undo.irreversible : undo === 'none' ? labels.undo.none : labels.undo.compensation;
}

/** The window title (tool's human name) as projected spans. */
export function approvalWindowTitle(input: ApprovalWindowInput, labels: ApprovalWindowLabels, known?: KnownSecretSnapshot): ApprovalDecisionLine {
  const call = approvalCallOf(input);
  if (!call) return approvalTemplateLine(labels.titleUnknown, {});
  const kind = approvalToolKind(call.tool), parts = approvalToolParts(call.tool), p = (text: string) => projectApprovalDecisionText(text, known);
  const tool = approvalTemplateLine(labels.tool[kind], { tool: p(parts.tool), server: p(parts.server) });
  return approvalTemplateLine(labels.title, { tool: { spans: tool.spans, hiddenCount: tool.fields.reduce((sum, field) => sum + field.hiddenCount, 0),
    patternMatches: tool.fields.flatMap(field => field.patternMatches) } });
}

/** The labelled rows of the approval window, top to bottom, at `now`. */
export function approvalWindowLines(input: ApprovalWindowInput, labels: ApprovalWindowLabels, now: number, known?: KnownSecretSnapshot): readonly ApprovalDecisionLine[] {
  const p = (text: string) => projectApprovalDecisionText(text, known), f = labels.field, call = approvalCallOf(input);
  const kind = approvalToolKind(call?.tool), parts = approvalToolParts(call?.tool);
  const { cut, body } = splitPreviewCut(input.preview ?? '');
  const shell = kind === 'shell' ? parseShellPreview(body) : null, edit = kind === 'edit' || kind === 'write' ? parseEditPreview(body) : null;
  const fetch = kind === 'fetch' ? parseFetchPreview(body) : null;
  const target = call?.target ?? null, path = target ?? '';
  const changes = edit ? approvalTemplateLine(labels.what.changes, { added: edit.added, removed: edit.removed }).spans : [];
  const what = approvalTemplateLine(labels.what[kind], { path: p(path), host: p(fetch?.host ?? target ?? ''), tool: p(parts.tool), server: p(parts.server),
    changes: { spans: changes, hiddenCount: 0, patternMatches: [] } });
  const rows: ApprovalDecisionLine[] = [];
  // A task or operation (or a producer this window does not know) keeps its own whole summary as the sentence, character for character.
  if (call) rows.push(lineOf(what.spans, what.fields, f.what));
  else projectedRows(p(input.summary)).forEach((row, index) => rows.push({ ...row, label: [span(index === 0 ? f.what : '', { bold: true })] }));
  // The full value: the command from the card's own `$` line (the call line's target is cut at 200 characters), the path, the URL.
  const value = shell ? { label: f.command, text: shell.command } : kind === 'edit' || kind === 'write' ? (target ? { label: f.file, text: target } : null)
    : fetch ? { label: f.address, text: fetch.url } : target ? { label: kind === 'shell' ? f.command : kind === 'fetch' ? f.address : f.target, text: target } : null;
  const valueRows = value ? projectedRows(p(value.text)) : [];
  valueRows.slice(0, VALUE_FIELD_ROWS).forEach((row, index) => rows.push({ ...row, label: [span(index === 0 ? value!.label : '', { bold: true })] }));
  if (valueRows.length > VALUE_FIELD_ROWS) rows.push({ ...lineOf([span(fillTemplate(labels.valueMore, { count: valueRows.length - VALUE_FIELD_ROWS }), { role: 'muted' })]), label: [span('')] });
  const where = input.project ? approvalTemplateLine(labels.where, { path: p(input.project) }) : approvalTemplateLine(labels.whereUnknown, {});
  rows.push(lineOf(where.spans, where.fields, f.where));
  // The realm's own posture sentence (engine text) stays under "where" until the event carries it structured (L1 decision point D2).
  if (shell?.posture) rows.push(...projectedRows(p(shell.posture)).map(row => ({ ...lineOf(withRole(row.spans, 'muted'), row.fields), label: [span('')], exact: false })));
  const self = input.requester === '-' || !input.requester;
  rows.push(lineOf(self ? [span(labels.onBehalfSelf)] : p(input.requester).spans,
    self ? [] : [p(input.requester)], f.onBehalf));
  rows.push(lineOf(approvalTemplateLine(labels.scope, { project: p(input.project ?? '') }).spans, [], f.scope));
  const cell = input.risk ?? null;
  const rule = (cell && labels.rule[cell]) || labels.rule['unknown']!, mode = (input.mode && labels.mode[input.mode]) || labels.mode['unknown']!;
  rows.push(lineOf(approvalTemplateLine(labels.why, { rule, mode }).spans, [], f.why));
  rows.push(lineOf([span(riskText(cell, labels), { role: cell === 'shell-destructive' || cell === 'edit-authority' || cell === 'mcp-floor' ? 'warning' : 'muted' })], [], f.risk));
  rows.push(lineOf([span(undoText(input.undo, labels))], [], f.undo));
  const left = input.expiresAt - now;
  rows.push(lineOf([span(left > 0 ? fillTemplate(labels.time, { clock: countdownClock(left) }) : labels.expired, { role: left > 0 ? 'accent' : 'error' })], [], f.time));
  if (input.assuranceLine || input.standing) rows.push(blank);
  if (input.assuranceLine) rows.push(input.assuranceLine);
  if (input.standing?.scopes.includes('session')) rows.push({ ...approvalTemplateLine(labels.sessionCovers, { pattern: p(input.standing.pattern) }), exact: true });
  if (input.standing?.scopes.includes('always')) rows.push({ ...approvalTemplateLine(labels.alwaysCovers, { pattern: p(input.standing.pattern) }), exact: true });
  // The preview section: the diff (edit), the tool's own text (MCP, other) or a preview whose shape is not the known one.
  const previewText = shell ? (valueRows.length > VALUE_FIELD_ROWS ? shell.command : '') : fetch ? '' : edit ? edit.diff : body;
  if (previewText || cut) {
    rows.push(blank, lineOf([span(f.preview, { bold: true })]));
    if (cut) rows.push(lineOf([span(fillTemplate(labels.previewCut, { shown: cut.shown, total: cut.total, bytes: cut.bytes, totalBytes: cut.totalBytes }), { role: 'warning' })]));
    if (previewText) rows.push(...diffRows(projectedRows(p(previewText))));
  }
  rows.push(blank, lineOf([span(f.detail, { bold: true })]));
  const detail = (template: string, values: Parameters<typeof approvalTemplateLine>[1]) => { const line = approvalTemplateLine(template, values); rows.push({ ...line, spans: withRole(line.spans, 'muted') }); };
  detail(labels.detail.id, { id: p(input.approvalId) });
  if (call) detail(labels.detail.binding, { summary: p(input.summary) });
  if (input.runId !== '-') detail(labels.detail.run, { run: p(input.runId), task: p(input.taskId) });
  if (cell) detail(labels.detail.cell, { cell: p(cell) });
  if (input.undo && !['irreversible', 'none'].includes(input.undo)) detail(labels.detail.compensation, { operation: p(input.undo) });
  if (shell) detail(labels.detail.classifier, { classifier: p(shell.classifier) });
  if (fetch?.rest) detail(labels.detail.engine, { text: p(fetch.rest.replace(/\n/gu, ' · ')) });
  if (cut) { detail(labels.detail.digest, { digest: cut.digest }); detail(cut.kept ? labels.detail.kept : labels.detail.notKept, { path: p(cut.kept ?? '') }); }
  if (input.requiredAssurance) detail(labels.detail.assurance, { level: p(input.requiredAssurance) });
  return rows;
}

/** The key-hint row: only the scopes the service offered, then deny, reason and scroll. */
export function approvalWindowHints(labels: ApprovalWindowLabels, scopes: readonly StandingScope[]): string {
  return [labels.keys.once, ...(scopes.includes('session') ? [labels.keys.session] : []), ...(scopes.includes('always') ? [labels.keys.always] : []),
    labels.keys.deny, labels.keys.reason, labels.keys.scroll].join(' · ');
}
