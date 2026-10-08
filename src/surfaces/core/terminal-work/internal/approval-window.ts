import { approvalTemplateLine, projectApprovalDecisionText, type ApprovalDecisionLine, type ApprovalDecisionProjection } from '#surfaces/core/approval-presentation/index.js';
import type { KnownSecretSnapshot } from '#platform/index.js';
import { AGENT_TOOL_UNDO, type AgentShellPosture, type AgentToolCardCall, type AgentToolUndo, type ApprovalPreviewCutFacts } from '#domain/index.js';
import { agentToolUndo } from '#engine/index.js';
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
  /** Catalog-operation facts (`irreversible`, `none`, `compensation`), the tool-call vocabulary (REVERSIBILITY) and `unknown` (not declared). */
  readonly undo: Readonly<Record<'none' | 'compensation' | 'unknown' | AgentToolUndo, string>>;
  /** POSTURE: a shell call's structured sandbox facts in words (`sandbox` has `{realm}`, `{project}`, `{git}`, `{network}`; `passedOver` `{realms}`). */
  readonly posture: Readonly<{ sandbox: string; host: string; degraded: string; passedOver: string;
    project: Readonly<Record<AgentShellPosture['project'], string>>; git: Readonly<Record<AgentShellPosture['git'], string>>;
    network: Readonly<Record<AgentShellPosture['network'], string>> }>;
  /** `{clock}` m:ss left. */
  readonly time: string; readonly expired: string;
  /** An `/approvals` row whose request time is not known. */
  readonly ageUnknown: string;
  /** `{shown}`, `{total}`, `{bytes}`, `{totalBytes}`. */
  readonly previewCut: string;
  /** `{count}`: rows of a long value (a heredoc command) not shown in its field; `fullCommand` (`{count}` rows) heads the whole command below. */
  readonly valueMore: string; readonly fullCommand: string;
  /** The card has no producer fields (an older service): the preview below is shown whole instead. */
  readonly noStructured: string;
  readonly detail: Readonly<Record<Details, string>>;
  /** `{pattern}`. */
  readonly sessionCovers: string; readonly alwaysCovers: string;
  readonly keys: Readonly<Record<'once' | 'session' | 'always' | 'deny' | 'reason' | 'scroll', string>>;
  readonly reason: Readonly<{ label: string; hint: string; empty: string }>;
  /** T3 L4: a config-change approval in the words of a setting — title, scope (`{key}`, `{layer}`), why (`{rule}`), undo, and the layer names. */
  readonly config?: Readonly<{ title: string; scope: string; why: string; undo: string; layers: Readonly<Record<'project' | 'global', string>> }>;
}

/** What the window knows of one approval (display copies only; no capability, revision or authority DTO). */
export type ApprovalWindowInput = Readonly<{
  approvalId: string; summary: string; requester: string; runId: string; taskId: string; expiresAt: number;
  tool?: string | undefined; target?: string | null | undefined; preview?: string | undefined; risk?: string | null | undefined; undo?: string | null | undefined;
  requiredAssurance?: string | undefined; assuranceLine?: ApprovalDecisionLine | null;
  standing?: Readonly<{ scopes: readonly StandingScope[]; pattern: string }> | null;
  project?: string | undefined; mode?: string | undefined; posture?: AgentShellPosture | undefined;
  /** v21 (Astra 2431): the card's fields as producer data and the preview cut's facts; absent (an older service): the preview is shown whole. */
  call?: AgentToolCardCall | undefined; previewCut?: ApprovalPreviewCutFacts | undefined;
  /** T3 L4: a config-change approval's facts; its window speaks of the setting (scope, rule, undo) instead of a tool call. */
  config?: Readonly<{ action: 'set' | 'unset'; layer: 'project' | 'global'; keyPath: string; ruleId: string }> | undefined;
}>;

/** A server follows the registry rule: 1–32 lower-case chars, starts with a letter, single inner hyphens. Accept both the literal name
 * and its `_` wire encoding; the first `__` is the separator. Show the server with its hyphens restored. */
const MCP_NAME = /^mcp__(?=[a-z0-9_-]{1,32}__)([a-z][a-z0-9]*(?:[-_][a-z0-9]+)*)__(.+)$/u;
/** The sealed binding line of a tool-call approval (`agentToolApprovalSummary`: `tool · resource · digest12`, a self-source reason may follow). */
const BINDING = /^([a-z][a-z0-9_-]{1,63}) · ([^\n]*) · [0-9a-f]{12}(?:\n|$)/u;
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
  return { tool: mcp ? mcp[2]! : name ?? '', server: mcp ? mcp[1]!.replace(/_/gu, '-') : '' };
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
const TOOL_UNDO: ReadonlySet<string> = new Set(AGENT_TOOL_UNDO);
const UNDO_KIND: Readonly<Partial<Record<ApprovalToolKind, Parameters<typeof agentToolUndo>[0]>>> = { shell: 'shell', edit: 'edit', write: 'edit', fetch: 'fetch' };
/**
 * REVERSIBILITY: the producer's word (a tool-call card's `undo`, a catalog operation's sealed facts) when it sent one; otherwise, for a call whose
 * kind the window knows (a stored card, an older service), the same domain classification from its tool and cell — never for an MCP tool,
 * whose server's declaration only the producer holds. Anything else is "not declared".
 */
function undoText(undo: string | null | undefined, kind: ApprovalToolKind | null, cell: string | null, labels: ApprovalWindowLabels): string {
  if (undo && TOOL_UNDO.has(undo)) return labels.undo[undo as AgentToolUndo];
  if (undo) return undo === 'none' ? labels.undo.none : labels.undo.compensation;
  const known = kind ? UNDO_KIND[kind] : undefined;
  return known ? labels.undo[agentToolUndo(known, cell)] : labels.undo.unknown;
}
/** POSTURE: where a shell call runs, in the person's language, from the event's structured facts (the realm id is its own name). */
function postureRows(posture: AgentShellPosture, labels: ApprovalWindowLabels): string[] {
  const words = labels.posture;
  const head = posture.containment === 'host' ? words.host : fillTemplate(words.sandbox, { realm: posture.realm, project: words.project[posture.project],
    git: words.git[posture.git], network: words.network[posture.network] });
  return [head, ...(posture.containment === 'degraded' ? [words.degraded] : []),
    ...(posture.passedOver.length ? [fillTemplate(words.passedOver, { realms: posture.passedOver.join(', ') })] : [])];
}

/** The window title (tool's human name) as projected spans. */
export function approvalWindowTitle(input: ApprovalWindowInput, labels: ApprovalWindowLabels, known?: KnownSecretSnapshot): ApprovalDecisionLine {
  if (input.config && labels.config) return approvalTemplateLine(labels.config.title, {});
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
  // Astra 2431 (L1 D4 for good): every field below is the producer's data; the preview text is never parsed, only shown — whole.
  const card = input.call ?? null, cut = input.previewCut ?? null, preview = input.preview ?? '';
  const target = call?.target ?? null;
  const changes = card?.kind === 'edit' ? approvalTemplateLine(labels.what.changes, { added: card.added, removed: card.removed }).spans : [];
  const what = approvalTemplateLine(labels.what[kind], { path: p(card?.kind === 'edit' ? card.path : target ?? ''), host: p(card?.kind === 'fetch' ? card.host : target ?? ''),
    tool: p(card?.kind === 'mcp' ? card.tool : parts.tool), server: p(card?.kind === 'mcp' ? card.server : parts.server), changes: { spans: changes, hiddenCount: 0, patternMatches: [] } });
  const rows: ApprovalDecisionLine[] = [];
  // A task or operation (or a producer this window does not know) keeps its own whole summary as the sentence, character for character.
  if (call) rows.push(lineOf(what.spans, what.fields, f.what));
  else projectedRows(p(input.summary)).forEach((row, index) => rows.push({ ...row, label: [span(index === 0 ? f.what : '', { bold: true })] }));
  // The full value from the producer: the whole command, the path, the URL. Without producer fields (a stored card, an older service) the call's own
  // line stands in — the call line the client saw or the sealed subject, which marks its own cut with "…" — and the note below says so.
  const value = card?.kind === 'shell' ? { label: f.command, text: card.command } : card?.kind === 'edit' ? { label: f.file, text: card.path }
    : card?.kind === 'fetch' ? { label: f.address, text: card.url } : !card && target && kind !== 'mcp'
      ? { label: kind === 'shell' ? f.command : kind === 'fetch' ? f.address : kind === 'edit' || kind === 'write' ? f.file : f.target, text: target } : null;
  const fallback = !card && call !== null && kind !== 'other';
  const valueRows = value ? projectedRows(p(value.text)) : [];
  valueRows.slice(0, VALUE_FIELD_ROWS).forEach((row, index) => rows.push({ ...row, label: [span(index === 0 ? value!.label : '', { bold: true })] }));
  if (valueRows.length > VALUE_FIELD_ROWS) rows.push({ ...lineOf([span(fillTemplate(labels.valueMore, { count: valueRows.length - VALUE_FIELD_ROWS }), { role: 'warning' })]), label: [span('')] });
  if (fallback) rows.push({ ...lineOf([span(labels.noStructured, { role: 'warning' })]), label: [span('')] });
  const where = input.project ? approvalTemplateLine(labels.where, { path: p(input.project) }) : approvalTemplateLine(labels.whereUnknown, {});
  rows.push(lineOf(where.spans, where.fields, f.where));
  // POSTURE (L1 D2/D4): the event's structured sandbox facts, worded here; nothing is parsed out of the engine's sentence.
  if (kind === 'shell' && input.posture) rows.push(...postureRows(input.posture, labels).map(text => ({ ...lineOf([span(text, { role: 'muted' })]), label: [span('')] })));
  const self = input.requester === '-' || !input.requester;
  rows.push(lineOf(self ? [span(labels.onBehalfSelf)] : p(input.requester).spans,
    self ? [] : [p(input.requester)], f.onBehalf));
  const cell = input.risk ?? null, setting = input.config && labels.config ? { facts: input.config, words: labels.config } : null;
  // T3 L4: a config-change approval names the setting and its layer, and the company rule that asked (the stored subject's own facts).
  if (setting) {
    const scope = approvalTemplateLine(setting.words.scope, { key: p(setting.facts.keyPath), layer: setting.words.layers[setting.facts.layer] });
    rows.push(lineOf(scope.spans, scope.fields, f.scope));
    const why = approvalTemplateLine(setting.words.why, { rule: p(setting.facts.ruleId) });
    rows.push(lineOf(why.spans, why.fields, f.why));
  } else {
    rows.push(lineOf(approvalTemplateLine(labels.scope, { project: p(input.project ?? '') }).spans, [], f.scope));
    const rule = (cell && labels.rule[cell]) || labels.rule['unknown']!, mode = (input.mode && labels.mode[input.mode]) || labels.mode['unknown']!;
    rows.push(lineOf(approvalTemplateLine(labels.why, { rule, mode }).spans, [], f.why));
  }
  rows.push(lineOf([span(riskText(cell, labels), { role: cell === 'shell-destructive' || cell === 'edit-authority' || cell === 'mcp-floor' ? 'warning' : 'muted' })], [], f.risk));
  // A config write keeps the previous value (the approval record's before copy; the write backs the layer up first): it can be put back.
  rows.push(lineOf([span(setting ? setting.words.undo : undoText(input.undo, call ? kind : null, cell, labels))], [], f.undo));
  const left = input.expiresAt - now;
  rows.push(lineOf([span(left > 0 ? fillTemplate(labels.time, { clock: countdownClock(left) }) : labels.expired, { role: left > 0 ? 'accent' : 'error' })], [], f.time));
  if (input.assuranceLine || input.standing) rows.push(blank);
  if (input.assuranceLine) rows.push(input.assuranceLine);
  if (input.standing?.scopes.includes('session')) rows.push({ ...approvalTemplateLine(labels.sessionCovers, { pattern: p(input.standing.pattern) }), exact: true });
  if (input.standing?.scopes.includes('always')) rows.push({ ...approvalTemplateLine(labels.alwaysCovers, { pattern: p(input.standing.pattern) }), exact: true });
  // A long command is never cut: its whole text, character for character, under its own heading (the preview text itself may be cut).
  if (valueRows.length > VALUE_FIELD_ROWS) rows.push(blank, lineOf([span(fillTemplate(labels.fullCommand, { count: valueRows.length }), { bold: true })]), ...valueRows);
  // The producer's preview, whole: no line is taken for metadata and dropped (in doubt, show). A diff keeps its +/- colour roles.
  if (preview || cut) {
    rows.push(blank, lineOf([span(f.preview, { bold: true })]));
    if (cut) rows.push(lineOf([span(fillTemplate(labels.previewCut, { shown: cut.shown, total: cut.total, bytes: cut.bytes, totalBytes: cut.totalBytes }), { role: 'warning' })]));
    if (preview) { const shown = projectedRows(p(preview)); rows.push(...(kind === 'edit' || kind === 'write' ? diffRows(shown) : shown)); }
  }
  rows.push(blank, lineOf([span(f.detail, { bold: true })]));
  const detail = (template: string, values: Parameters<typeof approvalTemplateLine>[1]) => { const line = approvalTemplateLine(template, values); rows.push({ ...line, spans: withRole(line.spans, 'muted') }); };
  detail(labels.detail.id, { id: p(input.approvalId) });
  if (call) detail(labels.detail.binding, { summary: p(input.summary) });
  if (input.runId !== '-') detail(labels.detail.run, { run: p(input.runId), task: p(input.taskId) });
  if (cell) detail(labels.detail.cell, { cell: p(cell) });
  if (input.undo && input.undo !== 'none' && !TOOL_UNDO.has(input.undo)) detail(labels.detail.compensation, { operation: p(input.undo) });
  if (card?.kind === 'shell') detail(labels.detail.classifier, { classifier: p(`${card.tier} (${card.reason})`) });
  if (cut) { detail(labels.detail.digest, { digest: cut.digest }); detail(cut.kept ? labels.detail.kept : labels.detail.notKept, { path: p(cut.kept ?? '') }); }
  if (input.requiredAssurance) detail(labels.detail.assurance, { level: p(input.requiredAssurance) });
  return rows;
}

/** The key-hint row: only the scopes the service offered, then deny, reason and scroll. */
export function approvalWindowHints(labels: ApprovalWindowLabels, scopes: readonly StandingScope[]): string {
  return [labels.keys.once, ...(scopes.includes('session') ? [labels.keys.session] : []), ...(scopes.includes('always') ? [labels.keys.always] : []),
    labels.keys.deny, labels.keys.reason, labels.keys.scroll].join(' · ');
}
