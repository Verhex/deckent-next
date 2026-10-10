// Standalone Node bootstrap mounted read-only. No host package imports at runtime.
import { get, request as httpRequest } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createServer, connect, type Socket } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// Worker Event Contract v1 (domain/core/worker-event) produced here, inside the container: this file cannot import host packages,
// so the shapes are mirrored and the host re-validates every event. Redaction happens before any byte leaves the container.
type BridgeEvent = Record<string, unknown> & { kind: string };
// B7 GENERATED REDACTOR BEGIN
// Canonical source+table sha256: 95a87a207de58b6f541f2d9832244040d317065db467290380925cccea7ab8fb; scripts/sync-worker-redactor.mjs --check
const REDACTION_TABLE = {"knownLabel":{"prefix":"‹secret:","suffix":"›","anonymous":"[REDACTED]"},"patterns":[{"id":"provider-token","source":"\\b(?:sk-(?:ant-)?[\\w-]+|gh[pousr]_[\\w]+|github_pat_[\\w]+|AKIA[A-Z0-9]{16}|xox[abp]-[A-Za-z0-9_-]{8,}|npm_[A-Za-z0-9]+|AIza[A-Za-z0-9_-]+)\\b","flags":"g","replacement":"[REDACTED]"},{"id":"bearer-token","source":"(Bearer\\s+)[A-Za-z0-9._~+/=-]{16,}","recordSource":"(Bearer\\s+)\\S+","flags":"gi","replacement":"$1[REDACTED]"},{"id":"url-userinfo","source":"(\\b[a-z][a-z0-9+.-]{0,31}://[^\\s/@:|\\x60\\x22<>?#]+:)[^\\s/@|\\x60\\x22<>?#]+(@)","flags":"gi","replacement":"$1[REDACTED]$2"},{"id":"key-value","source":"((?<![\\w-])(?:[\\w-]*(?:password|passwd|token|secret|api[_-]?key|private[_-]?key)|authorization|cookie)\\s*=\\s*)[^\\s;|&$()\\x60\\x27\\x22<>]+","flags":"gi","replacement":"$1[REDACTED]"},{"id":"jwt","source":"\\beyJ[\\w-]+\\.[\\w-]+\\.[\\w-]+\\b","flags":"g","replacement":"[REDACTED]"}]};

export interface NamedKnownSecret { readonly name: string | null; readonly value: string }
export interface RedactionMatch { readonly kind: string; readonly count: number }
export interface RedactionResult { readonly text: string; readonly knownMatches: number; readonly patternMatches: readonly RedactionMatch[] }
/** Opaque, per-operation snapshot of values already resolved by an authorized producer. JSON never exposes the values. */
export interface KnownSecretSpan { readonly start: number; readonly end: number; readonly label: string }
export interface KnownSecretSnapshot {
  readonly spans: (text: string) => readonly KnownSecretSpan[];
  /** Record attribution only; raw known values take priority over this snapshot's own label lookalikes. */
  readonly recordSpans: (text: string) => readonly KnownSecretSpan[];
  readonly apply: (text: string, redactRest: (text: string) => string) => { readonly text: string; readonly matches: number };
}
const label = (name: string | null) => name === null ? REDACTION_TABLE.knownLabel.anonymous : REDACTION_TABLE.knownLabel.prefix + name + REDACTION_TABLE.knownLabel.suffix;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Every exact UTF-16 start is covered; longest value wins at the same start, duplicate values use the first canonical name. */
export function snapshotKnownSecrets(input: readonly NamedKnownSecret[]): KnownSecretSnapshot {
  if (input.some(entry => entry.name !== null && !/^[A-Z_][A-Z0-9_]{0,127}$/.test(entry.name))) throw new Error('REDACTION_KNOWN_NAME_INVALID');
  const entries = input.filter(entry => entry.value.length >= 6)
    .map(entry => ({ ...entry })).sort((a, b) => b.value.length - a.value.length || ((a.name ?? '') < (b.name ?? '') ? -1 : (a.name ?? '') > (b.name ?? '') ? 1 : 0));
  const names = new Map<string, string | null>();
  for (const entry of entries) if (!names.has(entry.value)) names.set(entry.value, entry.name);
  const source = [...names.keys()].map(escape).join('|');
  const spans = (text: string): readonly KnownSecretSpan[] => Object.freeze(source ? [...text.matchAll(new RegExp(`(?=(${source}))`, 'g'))]
    .map(match => Object.freeze({ start: match.index, end: match.index + match[1]!.length, label: label(names.get(match[1]!) ?? null) })) : []);
  const recordSource = [...new Set([...names.values()].filter(name => name !== null).map(label))].map(escape).join('|');
  const recordSpans = (text: string): readonly KnownSecretSpan[] => {
    const raw = spans(text), records: KnownSecretSpan[] = [];
    let rawIndex = 0, rawEnd = 0;
    if (recordSource) for (const match of text.matchAll(new RegExp(`(?=(${recordSource}))`, 'g'))) {
      const start = match.index, end = start + match[1]!.length;
      while (rawIndex < raw.length && raw[rawIndex]!.start < end) { rawEnd = Math.max(rawEnd, raw[rawIndex]!.end); rawIndex++; }
      // A literal label containing an actual registered value is still raw secret text, never a masking exemption.
      if (rawEnd <= start) records.push(Object.freeze({ start, end, label: match[1]! }));
    }
    return Object.freeze([...raw, ...records]);
  };
  return Object.freeze({ spans, recordSpans, apply(text: string, redactRest: (text: string) => string) {
    const matches = spans(text), merged: { start: number; end: number; labels: string[] }[] = [];
    for (const match of matches) {
      const previous = merged.at(-1);
      if (previous && match.start < previous.end) { previous.end = Math.max(previous.end, match.end); previous.labels.push(match.label); }
      else merged.push({ start: match.start, end: match.end, labels: [match.label] });
    }
    let cursor = 0, out = '';
    for (const match of merged) {
      out += redactRest(text.slice(cursor, match.start)) + [...new Set(match.labels)].join('');
      cursor = match.end;
    }
    return { text: out + redactRest(text.slice(cursor)), matches: matches.length };
  } });
}
export const EMPTY_KNOWN_SECRETS = snapshotKnownSecrets([]);
/** One canonical versioned table; the standalone worker mirror is generated from this table and implementation. */
export const REDACTION_PATTERNS = Object.freeze(REDACTION_TABLE.patterns.map(row => Object.freeze({ ...row })));
const patterns = (text: string) => Object.freeze(REDACTION_PATTERNS.map(row => ({ kind: row.id, count: [...text.matchAll(new RegExp(row.source, row.flags))].length })).filter(row => row.count > 0).map(row => Object.freeze(row)));
/** Derived record text only: recordSource preserves legacy record coverage; counters/standing use source.
 * Merge original-text coverage before replacing. This snapshot's generated labels retain attribution without
 * exempting any pattern coverage or raw known value, including literal marker lookalikes. */
export function redactForRecord(text: string, known: KnownSecretSnapshot = EMPTY_KNOWN_SECRETS): string {
  const spans: { start: number; end: number; labels: string[] }[] = known.recordSpans(text).map(match => ({ start: match.start, end: match.end, labels: [match.label] }));
  for (const row of REDACTION_PATTERNS) for (const match of text.matchAll(new RegExp(row.recordSource ?? row.source, row.flags))) {
    const prefix = row.replacement.startsWith('$1') ? match[1]!.length : 0, suffix = row.replacement.endsWith('$2') ? match[2]!.length : 0;
    spans.push({ start: match.index + prefix, end: match.index + match[0].length - suffix, labels: [] });
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: typeof spans = [];
  for (const span of spans) {
    const previous = merged.at(-1);
    if (previous && span.start < previous.end) { previous.end = Math.max(previous.end, span.end); previous.labels.push(...span.labels); }
    else merged.push({ ...span, labels: [...span.labels] });
  }
  let cursor = 0, out = '';
  for (const span of merged) {
    out += text.slice(cursor, span.start) + (span.labels.length ? [...new Set(span.labels)].join('') : REDACTION_TABLE.knownLabel.anonymous);
    cursor = span.end;
  }
  return out + text.slice(cursor);
}
/** Unknown credential-shaped text stays byte-for-byte visible in decision mode; counts contain no values. */
export function redactForDecision(text: string, known: KnownSecretSnapshot = EMPTY_KNOWN_SECRETS): RedactionResult {
  const result = known.apply(text, part => part);
  return Object.freeze({ text: result.text, knownMatches: result.matches, patternMatches: patterns(text) });
}
export function hasSecret(text: string, known: KnownSecretSnapshot = EMPTY_KNOWN_SECRETS): boolean {
  return known.apply(text, part => part).matches > 0 || REDACTION_PATTERNS.some(row => new RegExp(row.source, row.flags).test(text));
}
// B7 GENERATED REDACTOR END
/** Compatibility worker display: same record producer, then legacy control stripping and length bound. */
export function redactText(value: string, secrets: readonly string[], max: number): string {
  let out = redactForRecord(value, snapshotKnownSecrets(secrets.map(value => ({ name: null, value }))));
  // eslint-disable-next-line no-control-regex
  out = out.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ');
  return out.length > max ? out.slice(0, max - 1) + '…' : out;
}
/** Every string leaf of a credential object is a secret value to scrub from worker-reported text. */
export function secretValues(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') into.push(value);
  else if (value && typeof value === 'object') for (const entry of Object.values(value)) secretValues(entry, into);
  return into;
}
/** B09-2: bounded claims, never acceptance. Mirrored by the pure domain report schema; no host imports in this mounted file. */
interface ReportLimits { reportBytes: number; summaryChars: number; changedFiles: number; changedFileChars: number; checks: number;
  checkCommandChars: number; openIssues: number; openIssueChars: number; handoffTaskIdChars: number; handoffSummaryChars: number;
  handoffArtifacts: number; handoffArtifactNameChars: number; handoffOpenQuestions: number; handoffOpenQuestionChars: number; sharedNotes: number; sharedNoteChars: number; promptBytes: number }
const reportText = (maxLength: number) => ({ type: 'string', maxLength });
const reportObject = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, required, properties });
export function createFinalReportJsonSchema(l: ReportLimits, strictSchema: boolean) {
  const texts = (maxItems: number, chars: number) => ({ type: 'array', maxItems, items: reportText(chars) });
  const schema = reportObject({ schemaVersion: { type: 'integer', const: 1 }, summary: reportText(l.summaryChars), changedFiles: texts(l.changedFiles, l.changedFileChars),
    checks: { type: 'array', maxItems: l.checks, items: reportObject({ command: reportText(l.checkCommandChars), outcome: { type: 'string', enum: ['passed', 'failed', 'not-run', 'unknown'] } }) },
    openIssues: texts(l.openIssues, l.openIssueChars), handoff: reportObject({ toTask: reportText(l.handoffTaskIdChars), summary: reportText(l.handoffSummaryChars),
      artifacts: { type: 'array', maxItems: l.handoffArtifacts, items: reportObject({ name: reportText(l.handoffArtifactNameChars), digest: { type: 'string', pattern: '^[a-f0-9]{64}$' } }) },
      openQuestions: texts(l.handoffOpenQuestions, l.handoffOpenQuestionChars) }, ['summary', 'artifacts', 'openQuestions']), sharedNotes: texts(l.sharedNotes, l.sharedNoteChars),
    exit: reportObject({ schemaVersion: { type: 'integer', const: 1 }, kind: { type: 'string', const: 'needs-input' },
      question: { ...reportText(l.handoffOpenQuestionChars), minLength: 1 } }),
  }, ['schemaVersion', 'summary', 'changedFiles', 'checks', 'openIssues']);
  if (strictSchema) {
    // OpenAI strict schemas require all properties. Null is transport-only and becomes absence before sealing.
    const handoff = schema.properties.handoff as ReturnType<typeof reportObject>;
    handoff.required = Object.keys(handoff.properties); handoff.properties.toTask = { type: ['string', 'null'], maxLength: l.handoffTaskIdChars };
    schema.properties.handoff = { anyOf: [handoff, { type: 'null' }] }; schema.required = Object.keys(schema.properties);
    schema.properties.exit = { anyOf: [schema.properties.exit, { type: 'null' }] };
  }
  return schema;
}
interface HandoffNote { toTask?: string; summary: string; artifacts: { name: string; digest: string }[]; openQuestions: string[] }
interface FinalReport { schemaVersion: 1; summary: string; changedFiles: string[]; checks: { command: string; outcome: 'passed' | 'failed' | 'not-run' | 'unknown' }[]; openIssues: string[];
  handoff?: HandoffNote; sharedNotes?: string[]; exit?: { schemaVersion: 1; kind: 'needs-input'; question: string } }
type FinalReportResult = { status: 'reported'; report: FinalReport } | { status: 'unavailable'; reason: 'invalid' | 'oversized' | 'missing' | 'unsupported' };
export function validateFinalReport(value: unknown, secrets: readonly string[], l: ReportLimits): FinalReportResult {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > l.reportBytes) return { status: 'unavailable', reason: 'oversized' };
  const object = (v: unknown, keys: string[], optional: string[] = []): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
    && Object.keys(v).every(k => keys.includes(k) || optional.includes(k)) && keys.every(k => Object.hasOwn(v, k));
  const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
  const texts = (v: unknown, count: number, max: number): v is string[] => Array.isArray(v) && v.length <= count && v.every(x => text(x, max));
  const handoff = (v: unknown) => object(v, ['summary', 'artifacts', 'openQuestions'], ['toTask'])
    && (!Object.hasOwn(v, 'toTask') || (text(v.toTask, l.handoffTaskIdChars) && v.toTask.length > 0)) && text(v.summary, l.handoffSummaryChars)
    && texts(v.openQuestions, l.handoffOpenQuestions, l.handoffOpenQuestionChars) && Array.isArray(v.artifacts) && v.artifacts.length <= l.handoffArtifacts
    && v.artifacts.every(a => object(a, ['name', 'digest']) && text(a.name, l.handoffArtifactNameChars) && a.name.length > 0 && typeof a.digest === 'string' && /^[a-f0-9]{64}$/.test(a.digest));
  const needsInput = (v: unknown) => object(v, ['schemaVersion', 'kind', 'question']) && v.schemaVersion === 1 && v.kind === 'needs-input'
    && text(v.question, l.handoffOpenQuestionChars) && v.question.trim().length > 0;
  if (!object(value, ['schemaVersion', 'summary', 'changedFiles', 'checks', 'openIssues'], ['handoff', 'sharedNotes', 'exit']) || value.schemaVersion !== 1
    || !text(value.summary, l.summaryChars) || !texts(value.changedFiles, l.changedFiles, l.changedFileChars) || !texts(value.openIssues, l.openIssues, l.openIssueChars)
    || (Object.hasOwn(value, 'handoff') && !handoff(value.handoff)) || (Object.hasOwn(value, 'sharedNotes') && !texts(value.sharedNotes, l.sharedNotes, l.sharedNoteChars))
    || (Object.hasOwn(value, 'exit') && !needsInput(value.exit))
    || !Array.isArray(value.checks) || value.checks.length > l.checks || !value.checks.every(c => object(c, ['command', 'outcome'])
      && text(c.command, l.checkCommandChars) && typeof c.outcome === 'string' && ['passed', 'failed', 'not-run', 'unknown'].includes(c.outcome))) return { status: 'unavailable', reason: 'invalid' };
  const input = value as unknown as FinalReport, red = (text: string, max: number) => redactText(text, secrets, max);
  const report: FinalReport = { schemaVersion: 1, summary: red(input.summary, l.summaryChars), changedFiles: input.changedFiles.map(x => red(x, l.changedFileChars)),
    checks: input.checks.map(x => ({ command: red(x.command, l.checkCommandChars), outcome: x.outcome })), openIssues: input.openIssues.map(x => red(x, l.openIssueChars)),
    ...(input.handoff ? { handoff: { ...(input.handoff.toTask === undefined ? {} : { toTask: red(input.handoff.toTask, l.handoffTaskIdChars) }),
      summary: red(input.handoff.summary, l.handoffSummaryChars), artifacts: input.handoff.artifacts.map(a => ({ name: red(a.name, l.handoffArtifactNameChars), digest: red(a.digest, a.digest.length) })),
      openQuestions: input.handoff.openQuestions.map(x => red(x, l.handoffOpenQuestionChars)) } } : {}),
    ...(input.sharedNotes ? { sharedNotes: input.sharedNotes.map(x => red(x, l.sharedNoteChars)) } : {}),
    ...(input.exit ? { exit: { schemaVersion: 1, kind: 'needs-input', question: red(input.exit.question.trim(), l.handoffOpenQuestionChars) } } : {}) };
  if (report.handoff && !handoff(report.handoff)) return { status: 'unavailable', reason: 'invalid' };
  return Buffer.byteLength(JSON.stringify(report)) > l.reportBytes ? { status: 'unavailable', reason: 'oversized' } : { status: 'reported', report };
}
function finalReportCollector(provider: string, secrets: readonly string[], limits: ReportLimits) {
  let result: FinalReportResult = { status: 'unavailable', reason: 'missing' };
  return {
    observe(line: string) {
      let data; try { data = JSON.parse(line) as Record<string, unknown>; } catch { return; }
      if (!data || typeof data !== 'object') return;
      if (provider === 'claude' && data.type === 'result') result = data.structured_output === undefined
        ? { status: 'unavailable', reason: 'missing' } : validateFinalReport(data.structured_output, secrets, limits);
      if (provider === 'codex' && data.type === 'item.completed') {
        const item = data.item as Record<string, unknown> | undefined;
        if (item?.type !== 'agent_message') return;
        try {
          const value = JSON.parse(String(item.text)) as Record<string, unknown>;
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            if (value.exit === null) delete value.exit;
            if (value.handoff === null) delete value.handoff;
            else if (value.handoff && typeof value.handoff === 'object' && !Array.isArray(value.handoff) && (value.handoff as Record<string, unknown>).toTask === null) delete (value.handoff as Record<string, unknown>).toTask;
          }
          result = validateFinalReport(value, secrets, limits);
        }
        catch { result = { status: 'unavailable', reason: 'invalid' }; }
      }
    },
    oversized() { result = { status: 'unavailable', reason: 'oversized' }; },
    finish: () => result,
  };
}
const CLAUDE_TOOLS: Readonly<Record<string, string>> = { Read: 'read', NotebookRead: 'read', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit',
  Write: 'write', Bash: 'shell', BashOutput: 'shell', KillShell: 'shell', KillBash: 'shell', Grep: 'search', Glob: 'search', LS: 'search',
  WebFetch: 'network', WebSearch: 'network', Task: 'agent', Agent: 'agent' };
const IGNORED_SYSTEM = new Set(['thinking_tokens', 'hook_started', 'hook_response', 'hook_progress', 'compact_boundary', 'informational', 'status']);
export interface NormalizerState { sequence: number; readonly startMs: number; cwd: string; readonly usageIds: Set<string>; readonly unmapped: Map<string, number>; readonly secrets: readonly string[] }
export function createNormalizerState(secrets: readonly string[], startMs = Date.now()): NormalizerState {
  return { sequence: 0, startMs, cwd: '/workspace', usageIds: new Set(), unmapped: new Map(), secrets };
}
/** Unmapped native type names are worker text too: redacted and bounded before they become counts (Astra 2066 R1). */
export function countUnmapped(state: NormalizerState, raw: string, count = 1): void {
  const key = redactText(raw, state.secrets, 64) || 'empty';
  state.unmapped.set(key, (state.unmapped.get(key) ?? 0) + count);
}
const num = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
function relative(path: unknown, cwd: string): string | null {
  if (typeof path !== 'string' || !path) return null;
  const root = cwd.endsWith('/') ? cwd : cwd + '/';
  if (path.startsWith(root)) return path.slice(root.length).slice(0, 256);
  if (!path.startsWith('/')) return path.slice(0, 256);
  return '(outside-workspace)/' + (path.split('/').pop() ?? '').slice(0, 200);
}
/** Maps one line of Claude Code stream-json onto zero or more contract events. Thinking text and tool output content are never kept. */
export function normalizeClaudeLine(line: string, state: NormalizerState, now = Date.now()): BridgeEvent[] {
  const events: BridgeEvent[] = [];
  const emit = (kind: string, body: Record<string, unknown>) => events.push({ schemaVersion: 1, sequence: ++state.sequence, atMs: Math.max(0, now - state.startMs), kind, ...body });
  const miss = (type: string) => countUnmapped(state, type);
  const red = (value: unknown, max: number) => redactText(typeof value === 'string' ? value : '', state.secrets, max);
  let data: Record<string, unknown>;
  try { const parsed: unknown = JSON.parse(line); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { miss('non-object'); return events; } data = parsed as Record<string, unknown>; }
  catch { if (line.trim()) miss('non-json'); return events; }
  const type = typeof data.type === 'string' ? data.type : 'untyped', subtype = typeof data.subtype === 'string' ? data.subtype : '';
  if (type === 'system' && subtype === 'init') {
    if (typeof data.cwd === 'string') state.cwd = data.cwd;
    emit('session.started', { provider: 'claude', model: typeof data.model === 'string' ? data.model.slice(0, 128) : null,
      cliVersion: typeof data.claude_code_version === 'string' ? data.claude_code_version.slice(0, 64) : null });
  } else if (type === 'system') { if (!IGNORED_SYSTEM.has(subtype)) miss(`system:${subtype}`); }
  else if (type === 'assistant') {
    const message = (data.message ?? {}) as Record<string, unknown>;
    const id = typeof message.id === 'string' ? message.id : null, usage = (message.usage ?? null) as Record<string, unknown> | null;
    // All messages of one API response share its id; count their usage once.
    if (id && usage && !state.usageIds.has(id)) {
      state.usageIds.add(id);
      emit('usage', { tokens: { input: num(usage.input_tokens), output: num(usage.output_tokens), cacheRead: num(usage.cache_read_input_tokens),
        cacheWrite: num(usage.cache_creation_input_tokens), thinking: null } });
    }
    for (const block of Array.isArray(message.content) ? message.content as Record<string, unknown>[] : []) {
      if (block.type === 'text') emit('message', { role: 'assistant', textBytes: Buffer.byteLength(String(block.text ?? '')), thinking: false, excerpt: red(block.text, 240) });
      else if (block.type === 'thinking' || block.type === 'redacted_thinking') emit('message', { role: 'assistant', textBytes: Buffer.byteLength(String(block.thinking ?? '')), thinking: true, excerpt: '' });
      else if (block.type === 'tool_use') {
        const name = typeof block.name === 'string' ? red(block.name, 64) || 'unknown' : 'unknown', input = (block.input ?? {}) as Record<string, unknown>;
        const toolClass = CLAUDE_TOOLS[name] ?? (name.startsWith('mcp__') ? 'network' : 'other');
        const path = relative(input.file_path ?? input.notebook_path ?? input.path, state.cwd);
        const target = path === null ? null : red(path, 256) || null;
        const detail = toolClass === 'shell' ? red(input.description ?? input.command, 240) : toolClass === 'search' ? red(input.pattern, 240)
          : toolClass === 'network' ? red(typeof input.url === 'string' ? (() => { try { return new URL(input.url).host; } catch { return ''; } })() : input.query, 240)
          : toolClass === 'agent' ? red(input.description, 240) : null;
        emit('tool.call', { toolId: red(block.id, 96), name, toolClass, target, detail: detail || null });
      } else miss(`assistant:${String(block.type ?? 'unknown')}`);
    }
  } else if (type === 'user') {
    const message = (data.message ?? {}) as Record<string, unknown>;
    for (const block of Array.isArray(message.content) ? message.content as Record<string, unknown>[] : []) {
      if (block.type !== 'tool_result') continue;
      emit('tool.result', { toolId: String(block.tool_use_id ?? '').slice(0, 96), status: block.is_error === true ? 'error' : 'ok',
        bytes: Buffer.byteLength(typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '')) });
    }
  } else if (type === 'rate_limit_event') {
    const info = (data.rate_limit_info ?? {}) as Record<string, unknown>, windows = (info.unifiedWindows ?? {}) as Record<string, Record<string, unknown>>;
    for (const [window, value] of Object.entries(windows)) {
      const utilization = typeof value.utilization === 'number' ? Math.min(1, Math.max(0, value.utilization)) : null;
      if (utilization !== null) emit('quota', { window: window.slice(0, 32), utilization, resetsAtMs: typeof value.resetsAt === 'number' ? Math.round(value.resetsAt * 1000) : null,
        status: String(info.status ?? 'unknown').slice(0, 32) });
    }
  } else if (type === 'result') {
    const limit = { error_max_turns: 'max-turns', error_max_budget_usd: 'budget', error_max_structured_output_retries: 'structured-output' }[subtype];
    if (limit) emit('limit', { limit, detail: subtype });
    const usage = (data.usage ?? {}) as Record<string, unknown>, details = (usage.output_tokens_details ?? {}) as Record<string, unknown>;
    const usage_ = data.modelUsage && typeof data.modelUsage === 'object' && !Array.isArray(data.modelUsage) ? data.modelUsage as Record<string, Record<string, unknown>> : null;
    const models = Object.values(usage_ ?? {});
    emit('session.ended', { outcome: subtype === 'success' && data.is_error !== true ? 'success' : limit ? 'limit' : 'error', turns: num(data.num_turns),
      durationMs: num(data.duration_ms), apiDurationMs: typeof data.duration_api_ms === 'number' ? num(data.duration_api_ms) : null,
      costUsd: typeof data.total_cost_usd === 'number' && Number.isFinite(data.total_cost_usd) && data.total_cost_usd >= 0 ? data.total_cost_usd : null,
      costBasis: typeof models[0]?.costBasis === 'string' ? String(models[0].costBasis).slice(0, 32) : null,
      tokens: { input: num(usage.input_tokens), output: num(usage.output_tokens), cacheRead: num(usage.cache_read_input_tokens), cacheWrite: num(usage.cache_creation_input_tokens),
        thinking: typeof details.thinking_tokens === 'number' ? num(details.thinking_tokens) : null },
      permissionDenials: Array.isArray(data.permission_denials) ? data.permission_denials.length : 0,
      // Every model the session used (exact ids as keys), so the host can compare them with the admitted model (WORKER-CURRENCY-1).
      ...(usage_ ? { models: Object.keys(usage_).sort().slice(0, 16).map(key => key.slice(0, 128)) } : {}) });
  } else miss(type);
  return events;
}
const CODEX_KNOWN = new Set(['thread.started', 'turn.started', 'item.updated']);
const CODEX_CHANGE_KINDS: Readonly<Record<string, 'write' | 'edit'>> = { add: 'write', update: 'edit', delete: 'edit' };
/** Changes attributed per file_change item; the rest are counted as unmapped, never silently dropped (Astra 2066 R3). */
const CODEX_MAX_CHANGES = 512;
/** Codex state beyond the shared normalizer state: seen tool items (by native id) and running token totals for the summary. */
export interface CodexNormalizerState { readonly calls: Set<string>; turns: number; measured: boolean; readonly tokens: { input: number; output: number; cacheRead: number; thinking: number | null } }
export function createCodexState(): CodexNormalizerState { return { calls: new Set(), turns: 0, measured: false, tokens: { input: 0, output: 0, cacheRead: 0, thinking: null } }; }
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
/**
 * Maps one line of `codex exec --json` onto contract events (B09-3). Shapes follow the pinned Codex 0.155.1 SDK item types
 * (openai/codex rust-v0.155.1 sdk/typescript/src/items.ts): command_execution, file_change, mcp_tool_call, web_search,
 * agent_message, reasoning, todo_list, error. Agent text is a redacted excerpt; reasoning and command output are never kept.
 * Unknown or malformed values are counted as unmapped and never become success; this function never throws (observation must
 * not change execution). `codex exec` runs one turn, so turn.completed/turn.failed end the session.
 */
export function normalizeCodexLine(line: string, state: NormalizerState, codex: CodexNormalizerState, now = Date.now()): BridgeEvent[] {
  const events: BridgeEvent[] = [];
  try { mapCodexLine(line, state, codex, now, events); }
  catch { countUnmapped(state, 'codex-invalid'); }
  return events;
}
function mapCodexLine(line: string, state: NormalizerState, codex: CodexNormalizerState, now: number, events: BridgeEvent[]): void {
  const emit = (kind: string, body: Record<string, unknown>) => events.push({ schemaVersion: 1, sequence: ++state.sequence, atMs: Math.max(0, now - state.startMs), kind, ...body });
  const miss = (type: string, count = 1) => countUnmapped(state, type, count);
  const red = (value: unknown, max: number) => redactText(typeof value === 'string' ? value : '', state.secrets, max);
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { if (line.trim()) miss('non-json'); return; }
  const data = record(parsed);
  if (!data) { miss('non-object'); return; }
  const type = typeof data.type === 'string' ? data.type : 'untyped';
  /** Stable, bounded, schema-valid tool id: a plain short native id as is, otherwise a digest (never the redacted text). */
  const toolId = (raw: string, suffix = '') => {
    const base = raw.length > 0 && raw.length <= 64 && /^[A-Za-z0-9_.:-]+$/.test(raw) && red(raw, 96) === raw ? raw : `h${createHash('sha256').update(raw).digest('hex').slice(0, 40)}`;
    return `${base}${suffix}`;
  };
  const call = (key: string, id: string, name: string, toolClass: string, target: string | null, detail: string | null) => {
    if (codex.calls.has(key)) return;
    codex.calls.add(key); emit('tool.call', { toolId: id, name, toolClass, target, detail: detail || null });
  };
  if (type === 'item.started' || type === 'item.completed') {
    const item = record(data.item);
    if (!item || typeof item.id !== 'string' || typeof item.type !== 'string') { miss('item-invalid'); return; }
    const rawId = item.id, id = toolId(rawId), done = type === 'item.completed', status = item.status;
    if (item.type === 'agent_message') { if (done) emit('message', { role: 'assistant', textBytes: Buffer.byteLength(typeof item.text === 'string' ? item.text : ''), thinking: false, excerpt: red(item.text, 240) }); }
    else if (item.type === 'reasoning') { if (done) emit('message', { role: 'assistant', textBytes: Buffer.byteLength(typeof item.text === 'string' ? item.text : ''), thinking: true, excerpt: '' }); }
    else if (item.type === 'command_execution') {
      call(rawId, id, 'shell', 'shell', null, red(item.command, 240));
      if (!done) return;
      if (status === 'completed' || status === 'failed') emit('tool.result', { toolId: id, status: status === 'completed' && item.exit_code === 0 ? 'ok' : 'error',
        bytes: Buffer.byteLength(typeof item.aggregated_output === 'string' ? item.aggregated_output : '') });
      else miss('command_execution.status');
    } else if (item.type === 'file_change') {
      // One apply_patch may touch several files: one call per path so every touched file is attributed, up to the cap.
      const changes = Array.isArray(item.changes) ? item.changes : [];
      changes.slice(0, CODEX_MAX_CHANGES).forEach((entry, index) => {
        const change = record(entry);
        if (!change || typeof change.path !== 'string') { miss('file_change.change-invalid'); return; }
        // Own keys only: '__proto__', 'constructor' and other inherited names are unknown kinds, not an allowed enum (Astra 2073).
        const kind = typeof change.kind === 'string' && Object.hasOwn(CODEX_CHANGE_KINDS, change.kind) ? CODEX_CHANGE_KINDS[change.kind] : undefined;
        if (!kind) miss('file_change.kind');
        const target = relative(change.path, state.cwd), changeId = toolId(rawId, `:${index}`);
        call(`${rawId}\u0000${index}`, changeId, 'apply_patch', kind ?? 'edit', target === null ? null : red(target, 256) || null, kind ? String(change.kind) : null);
        if (!done) return;
        if (status === 'completed' || status === 'failed') emit('tool.result', { toolId: changeId, status: status === 'completed' ? 'ok' : 'error', bytes: 0 });
        else miss('file_change.status');
      });
      if (changes.length > CODEX_MAX_CHANGES) miss('file_change.changes-over-cap', changes.length - CODEX_MAX_CHANGES);
    } else if (item.type === 'mcp_tool_call') {
      call(rawId, id, red(`mcp:${String(item.server ?? '')}/${String(item.tool ?? '')}`, 64) || 'mcp', 'network', null, null);
      if (!done) return;
      // An unknown or missing status never becomes success.
      if (status === 'completed' || status === 'failed') emit('tool.result', { toolId: id, status: status === 'completed' ? 'ok' : 'error', bytes: 0 });
      else miss('mcp_tool_call.status');
    } else if (item.type === 'web_search') {
      call(rawId, id, 'web_search', 'network', null, red(item.query, 240));
      if (done) emit('tool.result', { toolId: id, status: 'ok', bytes: 0 });
    } else if (item.type === 'error') { if (done) miss('item:error'); }
    else if (item.type !== 'todo_list') miss(`item:${item.type}`);
  } else if (type === 'turn.completed' || type === 'turn.failed') {
    codex.turns++;
    // A missing or malformed usage record is unknown, never a measured zero (Astra 2073).
    const usage = record(data.usage);
    if (!usage) {
      if (data.usage !== undefined) miss('usage-invalid');
      emit('session.ended', { outcome: type === 'turn.completed' ? 'success' : 'error', turns: codex.turns, durationMs: Math.max(0, now - state.startMs),
        apiDurationMs: null, costUsd: null, costBasis: null, tokens: codex.measured ? { ...codex.tokens, cacheWrite: 0 } : null, permissionDenials: 0 });
      return;
    }
    const cached = num(usage.cached_input_tokens);
    // OpenAI input totals include cached tokens; the contract counts them apart, like Claude's cache_read.
    const tokens = { input: Math.max(0, num(usage.input_tokens) - cached), output: num(usage.output_tokens), cacheRead: cached, cacheWrite: 0,
      thinking: typeof usage.reasoning_output_tokens === 'number' ? num(usage.reasoning_output_tokens) : null };
    if (type === 'turn.completed') {
      emit('usage', { tokens }); codex.measured = true;
      codex.tokens.input += tokens.input; codex.tokens.output += tokens.output; codex.tokens.cacheRead += tokens.cacheRead;
      if (tokens.thinking !== null) codex.tokens.thinking = (codex.tokens.thinking ?? 0) + tokens.thinking;
    }
    emit('session.ended', { outcome: type === 'turn.completed' ? 'success' : 'error', turns: codex.turns, durationMs: Math.max(0, now - state.startMs),
      apiDurationMs: null, costUsd: null, costBasis: null, tokens: { ...codex.tokens, cacheWrite: 0 }, permissionDenials: 0 });
  } else if (!CODEX_KNOWN.has(type)) miss(type);
}
/**
 * Splits a native stdout stream into lines and normalizes each onto contract events. Observation never changes execution:
 * a normalizer or delivery fault is counted as unmapped and never thrown into the child process listeners (Astra 2066 R2).
 */
export function createNativeLineObserver(provider: string, state: NormalizerState, codex: CodexNormalizerState, push: (events: BridgeEvent[]) => void, report?: ReturnType<typeof finalReportCollector>) {
  let pending = ''; let skipping = false;
  const decoder = new TextDecoder();
  const normalizeLine = (line: string) => {
    try {
      if (Buffer.byteLength(line) > 1_048_576) { report?.oversized(); countUnmapped(state, 'oversized-line'); return; }
      report?.observe(line);
      if (provider === 'claude') push(normalizeClaudeLine(line, state));
      else if (provider === 'codex') push(normalizeCodexLine(line, state, codex));
      else if (line.trim()) countUnmapped(state, `${provider}-event`);
    } catch { countUnmapped(state, 'normalizer-error'); }
  };
  return {
    observe(part: Buffer) {
      for (const piece of decoder.decode(part, { stream: true }).split(/(?<=\n)/)) {
        const ended = piece.endsWith('\n');
        if (!skipping) pending += piece;
        if (Buffer.byteLength(pending) > 1_048_576) { report?.oversized(); countUnmapped(state, 'oversized-line'); pending = ''; skipping = true; }
        if (ended) { if (!skipping) normalizeLine(pending.trimEnd()); pending = ''; skipping = false; }
      }
    },
    flush() { pending += decoder.decode(); if (pending && !skipping) normalizeLine(pending); pending = ''; },
  };
}
/** Unmapped native event types are reported as counts, never silently dropped. */
export function flushUnmapped(state: NormalizerState, now = Date.now()): BridgeEvent[] {
  const events: BridgeEvent[] = [];
  for (const [nativeType, count] of state.unmapped) events.push({ schemaVersion: 1, sequence: ++state.sequence, atMs: Math.max(0, now - state.startMs), kind: 'unmapped', nativeType, count });
  state.unmapped.clear();
  return events;
}
/** Best-effort, bounded delivery of event batches to the attempt gateway. Observation never changes execution. */
function eventChannel(socketPath: string, maxQueued = 4000, batch = 64) {
  const queue: BridgeEvent[] = []; let dropped = 0, sending: Promise<void> = Promise.resolve();
  const post = (events: BridgeEvent[]) => new Promise<void>(resolve => {
    const body = events.map(event => JSON.stringify(event)).join('\n') + '\n';
    const request = httpRequest({ socketPath, path: '/events', method: 'POST', timeout: 5000,
      headers: { 'content-type': 'application/x-ndjson', 'content-length': Buffer.byteLength(body) } }, response => { response.resume(); response.on('end', resolve); response.on('error', () => resolve()); });
    request.on('error', () => resolve()); request.on('timeout', () => { request.destroy(); resolve(); }); request.end(body);
  });
  const flush = () => { sending = sending.then(async () => { while (queue.length) { const next = queue.splice(0, batch); await post(next); } }); return sending; };
  const timer = setInterval(() => { void flush(); }, 500); timer.unref();
  return {
    push(events: BridgeEvent[]) { for (const event of events) { if (queue.length >= maxQueued) dropped++; else queue.push(event); } if (queue.length >= batch) void flush(); },
    async close(state: NormalizerState) {
      clearInterval(timer);
      if (dropped) queue.push({ schemaVersion: 1, sequence: ++state.sequence, atMs: Math.max(0, Date.now() - state.startMs), kind: 'dropped', reason: 'event-cap', count: dropped });
      await flush();
    },
  };
}

/** Mirrored registry capability payload: the mounted bootstrap cannot import host packages. */
export interface NativeWorkerCapabilities {
  readonly maxTurns: { readonly flag: string; readonly hiddenHelpProbe: { readonly args: readonly string[]; readonly refusal: string } | null } | null;
  readonly settings: { readonly flag: string } | null;
  readonly promptChannel: 'claude-system-prompt' | 'codex-instructions-file' | 'inline';
  readonly structuredReport: { readonly flag: string; readonly channel: 'inline-json' | 'schema-file' } | null;
  readonly modelUsageEvidence: 'session-events' | 'none';
}
/** Validates native prompt custody and returns the argv delivered to the CLI, selected only by capability. */
export function nativePromptArguments(input: readonly string[], core: string, task: string, capabilities: NativeWorkerCapabilities): string[] {
  const argv = [...input], channel = capabilities.promptChannel;
  if (argv.at(-2) !== '--' || argv.at(-1) !== '__DECKENT_TASK_PROMPT__') throw new Error();
  argv[argv.length - 1] = channel === 'inline' ? core + '\n\n' + task : task;
  if (channel === 'claude-system-prompt') {
    const index = argv.indexOf('--system-prompt');
    if (index < 0 || argv[index + 1] !== '__DECKENT_CORE_PROMPT__') throw new Error();
    argv[index + 1] = core;
  }
  if (channel === 'codex-instructions-file' && (!argv.includes('model_instructions_file="/tmp/deckent-prompt/core.txt"')
    || !argv.includes('project_doc_max_bytes=0'))) throw new Error();
  return argv;
}
/** Required flags and hidden-parser probes are registry data; the parser refusal must match exactly. */
export function nativePreflightCapabilities(capabilities: NativeWorkerCapabilities,
  preflight: { schemaVersion: number; cliVersion: string; helpArgs: readonly string[]; requiredFlags: readonly string[] }, run: (args: readonly string[]) => string): boolean {
  const version = run(['--version']).trim(), help = run(preflight.helpArgs).split(/[\s,=]+/);
  if (preflight.schemaVersion !== 1 || version !== preflight.cliVersion || preflight.requiredFlags.some(flag => {
    if (help.includes(flag)) return false;
    const probe = capabilities.maxTurns?.hiddenHelpProbe;
    if (flag === capabilities.maxTurns?.flag && probe) {
      try { run(probe.args); }
      catch (error) { return !String((error as { stderr?: unknown }).stderr ?? '').includes(probe.refusal); }
    }
    return true;
  })) throw new Error();
  return capabilities.structuredReport !== null && help.includes(capabilities.structuredReport.flag);
}
export function nativeReportArguments(capabilities: NativeWorkerCapabilities, schema: string): string[] {
  const report = capabilities.structuredReport;
  return report ? [report.flag, report.channel === 'inline-json' ? schema : '/tmp/deckent-report-schema.json'] : [];
}

async function main() {
  const socketPath = '/run/deckent-connection.sock';
  const payload = await new Promise<string>((resolve, reject) => {
    const request = get({ socketPath, path: '/bootstrap', timeout: 10000 }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (part: string) => { text += part; if (Buffer.byteLength(text) > 131072) request.destroy(new Error()); });
      response.on('error', reject); response.on('end', () => response.statusCode === 200 ? resolve(text) : reject(new Error()));
    });
    request.on('error', reject); request.on('timeout', () => request.destroy(new Error()));
  });
  const setup = JSON.parse(payload) as { schemaVersion: number; provider: string; capabilities: NativeWorkerCapabilities; home: string; file: string;
    credential: Record<string, unknown>; credentialEnvironment?: string; environment: Record<string, string>; limits: { connections: number; idleMs: number };
    finalReport?: { schemaVersion: 1; limits: ReportLimits };
    dependencyContext?: { text: string; sha256: string; maxBytes: number };
    preflight?: { schemaVersion: number; cliVersion: string; helpArgs: string[]; requiredFlags: string[] };
    promptDelivery?: { schemaVersion: number; channel: string; core: string; task: string;
      segments: { kind: string; id: string; version: number; sha256: string }[]; sha256: string; argvSha256: string } };
  const home = '/tmp/deckent-home';
  if (setup.schemaVersion !== 1 || setup.home.includes('..') || setup.home.startsWith('/') || setup.file.includes('/')) throw new Error();
  const [executable, ...argv] = process.argv.slice(2); if (!executable) throw new Error();
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  const delivery = setup.promptDelivery, context = setup.dependencyContext;
  if (context && (!delivery || !Number.isSafeInteger(context.maxBytes) || context.maxBytes <= 0 || Buffer.byteLength(context.text) > context.maxBytes
    || hash(context.text) !== context.sha256)) throw new Error();
  const deliveredTask = delivery ? delivery.task + (context ? '\n\n' + context.text : '') : null;
  if (delivery) {
    // Validate custody before writing credentials or executing any native tools.
    const { sha256, argvSha256, ...body } = delivery;
    const channel = setup.capabilities.promptChannel;
    if (delivery.schemaVersion !== 1 || delivery.channel !== channel || !setup.preflight
      || hash(JSON.stringify(body)) !== sha256 || hash(JSON.stringify([executable, ...argv])) !== argvSha256
      || argv.at(-2) !== '--' || argv.at(-1) !== '__DECKENT_TASK_PROMPT__') throw new Error();
    const root = '/tmp/deckent-prompt'; await mkdir(root, { mode: 0o700 });
    await writeFile(join(root, 'core.txt'), delivery.core, { mode: 0o600, flag: 'wx' });
    argv.splice(0, argv.length, ...nativePromptArguments(argv, delivery.core, deliveredTask!, setup.capabilities));
  }
  let reportSupported = false;
  if (setup.preflight) {
    // Probe in a clean directory before credentials are written or task tools can run.
    const probe = '/tmp/deckent-preflight'; await mkdir(probe, { mode: 0o700 });
    try {
      const run = (args: readonly string[]) => execFileSync(executable, args, { cwd: probe, timeout: 10000,
        maxBuffer: 1048576, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH, HOME: probe, LANG: 'C.UTF-8', DISABLE_AUTOUPDATER: '1' } });
      reportSupported = nativePreflightCapabilities(setup.capabilities, setup.preflight, run);
    } catch {
      process.stdout.write(JSON.stringify({ schemaVersion: 1, kind: 'native-coding-exit', code: 78,
        signal: null, outputBytes: 0, failure: 'preflight' }) + '\n');
      process.exitCode = 78; return;
    }
  }
  if (setup.finalReport && reportSupported) {
    const schema = JSON.stringify(createFinalReportJsonSchema(setup.finalReport.limits, setup.capabilities.structuredReport?.channel === 'schema-file'));
    const extra = nativeReportArguments(setup.capabilities, schema);
    if (setup.capabilities.structuredReport?.channel === 'schema-file') await writeFile('/tmp/deckent-report-schema.json', schema, { mode: 0o600, flag: 'wx' });
    const end = argv.lastIndexOf('--'); argv.splice(end < 0 ? argv.length : end, 0, ...extra);
  }
  const authRoot = join(home, setup.home); await mkdir(authRoot, { recursive: true, mode: 0o700 });
  await writeFile(join(authRoot, setup.file), JSON.stringify(setup.credential), { mode: 0o600, flag: 'wx' });
  if (setup.provider === 'claude') await writeFile(join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }), { mode: 0o600 });
  if (setup.provider === 'cursor') {
    await mkdir(join(home, '.cursor'), { mode: 0o700 });
    await writeFile(join(home, '.cursor/cli-config.json'), JSON.stringify({ version: 1, editor: { vimMode: false },
      permissions: { allow: [], deny: [] }, network: { useHttp1ForAgent: true } }), { mode: 0o600 });
  }
  const sockets = new Set<Socket>();
  const relay = createServer(client => {
    const remote = connect(socketPath); sockets.add(client); sockets.add(remote);
    const close = () => { client.destroy(); remote.destroy(); sockets.delete(client); sockets.delete(remote); };
    client.on('error', close); remote.on('error', close); client.on('close', close); remote.on('close', close);
    client.setTimeout(setup.limits.idleMs, close); remote.setTimeout(setup.limits.idleMs, close);
    client.pipe(remote); remote.pipe(client);
  });
  relay.maxConnections = setup.limits.connections;
  await new Promise<void>((resolve, reject) => { relay.once('error', reject); relay.listen(0, '127.0.0.1', resolve); });
  const address = relay.address(); if (!address || typeof address === 'string') throw new Error();
  const proxy = `http://127.0.0.1:${address.port}`;
  const child = spawn(executable, argv, { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: home,
    LANG: 'C.UTF-8', ...setup.environment,
    ...(setup.credentialEnvironment && typeof setup.credential.accessToken === 'string' ? { [setup.credentialEnvironment]: setup.credential.accessToken } : {}),
    HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy,
    NO_PROXY: '', no_proxy: '' } });
  if (delivery) child.once('spawn', () => process.stdout.write(JSON.stringify({ schemaVersion: 1,
    kind: 'native-prompt-delivery', phase: 'spawned', channel: delivery.channel, sha256: delivery.sha256,
    argvSha256: hash(JSON.stringify([executable, ...argv])), coreSha256: hash(delivery.core), taskSha256: hash(deliveredTask!), ...(context ? { dependencyContextSha256: context.sha256 } : {}),
    segments: delivery.segments }) + '\n'));
  // Native events can contain tool output and request headers. Never forward raw events: only redacted contract events leave.
  let tail = ''; let bytes = 0;
  const state = createNormalizerState([...secretValues(setup.credential), proxy]);
  const channel = eventChannel(socketPath);
  const codex = createCodexState();
  if (setup.capabilities.modelUsageEvidence === 'none') channel.push([{ schemaVersion: 1, sequence: ++state.sequence, atMs: 0, kind: 'session.started', provider: setup.provider, model: null, cliVersion: null }]);
  const capture = (part: Buffer) => { bytes += part.length; tail = (tail + part.toString('utf8')).slice(-65536); };
  const report = setup.finalReport && reportSupported ? finalReportCollector(setup.provider, state.secrets, setup.finalReport.limits) : undefined;
  const lineObserver = createNativeLineObserver(setup.provider, state, codex, events => channel.push(events), report);
  const observe = (part: Buffer) => { capture(part); lineObserver.observe(part); };
  child.stdout.on('data', observe); child.stderr.on('data', capture);
  const result = await new Promise<{ code: number | null; signal: string | null }>(resolve => {
    child.on('error', () => resolve({ code: null, signal: null }));
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  const failure = /unauthorized|authentication|log in|login|401|token.*expired/i.test(tail) ? 'authentication'
    : /quota|rate.limit|usage.limit|429/i.test(tail) ? 'capacity'
    : /model.*not.*(found|supported|available)|invalid.model/i.test(tail) ? 'model'
    : /connect|proxy|network|fetch failed|socket|ENOTFOUND|ECONN/i.test(tail) ? 'connection' : 'native';
  lineObserver.flush();
  if (setup.finalReport) {
    const final = report?.finish() ?? { status: 'unavailable', reason: 'unsupported' };
    if (final.status === 'unavailable' && (final.reason === 'invalid' || final.reason === 'oversized')) channel.push([
      { schemaVersion: 1, sequence: ++state.sequence, atMs: Math.max(0, Date.now() - state.startMs), kind: 'dropped', reason: final.reason === 'oversized' ? 'byte-cap' : 'invalid', count: 1 }]);
    process.stdout.write(JSON.stringify({ schemaVersion: 1, kind: 'native-worker-report', ...final }) + '\n');
  }
  channel.push(flushUnmapped(state)); await channel.close(state);
  process.stdout.write(JSON.stringify({ schemaVersion: 1, kind: 'native-coding-exit', ...result, outputBytes: bytes,
    failure: result.code === 0 ? null : failure }) + '\n');
  for (const socket of sockets) socket.destroy(); relay.close();
  process.exitCode = result.code === 0 ? 0 : 1;
}
// Runs only as the mounted bootstrap (`node /run/deckent-bootstrap.mjs ...`); importing it for tests has no side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write('NATIVE_BOOTSTRAP_FAILED\n'); process.exitCode = 78; });
}
