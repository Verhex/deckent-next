// Standalone Node bootstrap mounted read-only. No host package imports at runtime.
import { get, request as httpRequest } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createServer, connect, type Socket } from 'node:net';
import { lstat, mkdir, open, readdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// Worker Event Contract v1 (domain/core/worker-event) produced here, inside the container: this file cannot import host packages,
// so the shapes are mirrored and the host re-validates every event. Redaction happens before any byte leaves the container.
type BridgeEvent = Record<string, unknown> & { kind: string };
// B7 GENERATED REDACTOR BEGIN
// Canonical source+table sha256: d2e0fe4c00632529263c78176a0ac494784f555f476c2a7c4acde2ae2cb18ed7; scripts/sync-worker-redactor.mjs --check
const REDACTION_TABLE = {"knownLabel":{"prefix":"‹secret:","suffix":"›","anonymous":"[REDACTED]"},"patterns":[{"id":"provider-token","gate":true,"source":"\\b(?:sk-(?:ant-)?[\\w-]+|gh[pousr]_[\\w]+|github_pat_[\\w]+|AKIA[A-Z0-9]{16}|xox[abp]-[A-Za-z0-9_-]{8,}|npm_[A-Za-z0-9]+|AIza[A-Za-z0-9_-]+)\\b","flags":"g","replacement":"[REDACTED]","streamPreviewSource":"\\b(?:sk-(?:ant-)?[\\w-]*|gh[pousr]_\\w*|github_pat_\\w*|AKIA[A-Z0-9]*|xox[abp]-[A-Za-z0-9_-]*|npm_[A-Za-z0-9]*|AIza[A-Za-z0-9_-]*)$"},{"id":"bearer-token","gate":true,"source":"(Bearer\\s+)[A-Za-z0-9._~+/=-]{16,}","recordSource":"(Bearer\\s+)\\S+","flags":"gi","replacement":"$1[REDACTED]","streamSource":"\\bBearer\\s*$"},{"id":"url-userinfo","gate":true,"source":"(\\b[a-z][a-z0-9+.-]{0,31}://[^\\s/@:|\\x60\\x22<>?#]+:)[^\\s/@|\\x60\\x22<>?#]+(@)","flags":"gi","replacement":"$1[REDACTED]$2","streamPreviewSource":"(\\b[a-z][a-z0-9+.-]{0,31}://[^\\s/@:|\\x60\\x22<>?#]+:)[^\\s/@|\\x60\\x22<>?#]*(@?)$"},{"id":"key-value","gate":false,"source":"((?<![\\w-])(?:[\\w-]*(?:password|passwd|token|secret|api[_-]?key|private[_-]?key)|authorization|cookie)\\s*=\\s*)[^\\s;|&$()\\x60\\x27\\x22<>]+","flags":"gi","replacement":"$1[REDACTED]","streamSource":"(?<![\\w-])(?:[\\w-]*(?:password|passwd|token|secret|api[_-]?key|private[_-]?key)|authorization|cookie)\\s*(?:=\\s*)?$"},{"id":"jwt","gate":true,"source":"((?<![\\w-])(?:(?!\\beyJ)[\\w-])*)\\beyJ[\\w-]+\\.[\\w-]+\\.[\\w-]+\\b","flags":"g","replacement":"$1[REDACTED]","streamPreviewSource":"((?<![\\w-])(?:(?!\\beyJ)[\\w-])*)\\beyJ[\\w-]*(?:\\.[\\w-]*){0,2}$"}],"gatePatterns":[{"id":"private-key-block","source":"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----","distributionSource":"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[ \\t\\r\\n]+(?:[A-Za-z0-9-]+:[^\\r\\n]*[\\r\\n]+)*(?:[A-Za-z0-9+/][ \\t\\r\\n]*){32}","flags":""},{"id":"gitlab-token","source":"\\bglpat-[A-Za-z0-9_-]{20,}","flags":""},{"id":"aws-temporary-key","source":"\\bASIA[A-Z0-9]{16}\\b","flags":""},{"id":"aws-secret-key","source":"aws_?secret_?access_?key[\"']?\\s*[:=]\\s*[\"']?[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])","flags":"i"},{"id":"stripe-key","source":"\\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}","flags":""},{"id":"slack-token","source":"\\b(?:xox[a-z]|xapp)-[A-Za-z0-9-]{8,}","flags":""},{"id":"pypi-token","source":"\\bpypi-[A-Za-z0-9_-]{50,}","flags":""},{"id":"azure-account-key","source":"\\b(?:AccountKey|SharedAccessKey)=[A-Za-z0-9+/]{20,}={0,2}","flags":"i"}],"configSecret":{"id":"config-secret","note":"S6 pre-dispatch gate only (redaction ignores it): the key-value vocabulary narrowed to config-like files and non-placeholder literal values. key-value itself stays gate:false (it matches ordinary code).","files":[".env",".env.*","*.json","*.yaml","*.yml","*.toml","*.ini","*.properties","*.conf","*.cfg","*.xml","docker-compose*","*.config"],"keys":["password","passwd","pwd","secret","token","api[_-]?key","private[_-]?key","access[_-]?key","account[_-]?key","shared[_-]?access[_-]?key","credentials?","connection[_-]?string","authorization","cookie"],"assignmentSource":"(?<![\\w.-])[\"']?([\\w.-]*(?:{keys}))[\"']?[ \\t]*[:=](?:[ \\t]*|\\s*(?=[\"']))(?:\"([^\"\\r\\n]*)\"|'([^'\\r\\n]*)'|(\\$\\{\\{[^}\\r\\n]*\\}\\}(?=(?:[ \\t]+#[^\\r\\n]*)?[ \\t]*(?:\\r\\n|\\r|\\n|$))|\\$\\{[^}\\r\\n]*\\}|<[^>\\r\\n]*>|[^\\s\"',;#}\\]<]+))","elementSource":"<(?:[\\w.-]+:)?([\\w.-]*(?:{keys}))(?:\\s[^<>]*)?>([^<\\r\\n]*)</","flags":"gi","placeholders":["^\\$\\{[A-Za-z_][A-Za-z0-9_]*(?::?\\?[^}]*)?\\}$","^\\$\\(?[A-Za-z_][A-Za-z0-9_]*\\)?$","^%[A-Za-z_][A-Za-z0-9_]*%$","^<[^<>]*>$","^\\{\\{[^'\"{}]*\\}\\}$","^\\$\\{\\{[ \\t]*(?:github|secrets|env|vars|inputs|steps|needs|matrix|runner|job|strategy)\\.[A-Za-z0-9_.\\-]+[ \\t]*\\}\\}$","^\\*+$","^[xX]+$","^(?:changeme|change[_-]?me|change[_-]?it|example|dummy|redacted|placeholder|null|none|nil|true|false|todo|tbd|fixme|secret|password|your[_-][\\w-]*|xxx[\\w-]*|\\.\\.\\.)$"],"minValueLength":6,"envDefaultSource":"^\\$\\{[A-Za-z_][A-Za-z0-9_]*:?[-=](.*)\\}$"}};

export interface NamedKnownSecret { readonly name: string | null; readonly value: string }
export interface RedactionMatch { readonly kind: string; readonly count: number }
export interface RedactionResult { readonly text: string; readonly knownMatches: number; readonly patternMatches: readonly RedactionMatch[] }
/** Opaque, per-operation snapshot of values already resolved by an authorized producer. JSON never exposes the values. */
export interface KnownSecretSpan { readonly start: number; readonly end: number; readonly label: string }
export interface KnownSecretSnapshot {
  readonly spans: (text: string) => readonly KnownSecretSpan[];
  /** Record attribution only; raw known values take priority over this snapshot's own label lookalikes. */
  /** Earliest suffix that can still grow into an exact known value; never exposes the values. */
  readonly pendingStart: (text: string) => number;
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
  // RECORD also covers a known value deliberately line-wrapped by its producer. DECISION still uses exact source bytes.
  const foldLines = (text: string) => {
    const offsets: number[] = [];
    for (let at = 0; at < text.length; at++) if (text[at] !== '\n' && !(text[at] === '\r' && text[at + 1] === '\n')) offsets.push(at);
    return { text: text.replace(/\r?\n/g, ''), offsets };
  };
  const lineSpans = (text: string): readonly KnownSecretSpan[] => {
    if (!source || !text.includes('\n')) return [];
    const flat = foldLines(text);
    return spans(flat.text).flatMap(span => {
      const start = flat.offsets[span.start]!, end = flat.offsets[span.end - 1]! + 1;
      return end - start > span.end - span.start ? [Object.freeze({ ...span, start, end })] : [];
    });
  };
  const recordSource = [...new Set([...names.values()].filter(name => name !== null).map(label))].map(escape).join('|');
  const recordSpans = (text: string): readonly KnownSecretSpan[] => {
    const raw = [...spans(text), ...lineSpans(text)].sort((a, b) => a.start - b.start || b.end - a.end), records: KnownSecretSpan[] = [];
    let rawIndex = 0, rawEnd = 0;
    if (recordSource) for (const match of text.matchAll(new RegExp(`(?=(${recordSource}))`, 'g'))) {
      const start = match.index, end = start + match[1]!.length;
      while (rawIndex < raw.length && raw[rawIndex]!.start < end) { rawEnd = Math.max(rawEnd, raw[rawIndex]!.end); rawIndex++; }
      // A literal label containing an actual registered value is still raw secret text, never a masking exemption.
      if (rawEnd <= start) records.push(Object.freeze({ start, end, label: match[1]! }));
    }
    return Object.freeze([...raw, ...records]);
  };
  const suffixStart = (text: string): number => {
    let start = text.length;
    for (const value of names.keys()) for (let length = Math.min(text.length, value.length - 1); length > text.length - start; length--) {
      if (value.startsWith(text.slice(-length))) { start = text.length - length; break; }
    }
    return start;
  };
  const pendingStart = (text: string): number => {
    if (!source) return text.length;
    const exact = suffixStart(text);
    // A trailing CR may be the first byte of a CRLF split across deltas; it cannot release a known prefix.
    if (text.endsWith('\r')) {
      const candidate = text.replace(/\r+$/g, ''), before = pendingStart(candidate);
      return Math.min(exact, before < candidate.length ? before : text.length);
    }
    if (!text.includes('\n')) return exact;
    const flat = foldLines(text), start = suffixStart(flat.text);
    return Math.min(exact, start < flat.text.length ? flat.offsets[start]! : text.length);
  };
  return Object.freeze({ spans, recordSpans, pendingStart, apply(text: string, redactRest: (text: string) => string) {
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
/** S6 gate-only row of the same table: the key-value vocabulary narrowed to config-like files and non-placeholder values (redaction ignores it). */
export const REDACTION_CONFIG_SECRET = Object.freeze(REDACTION_TABLE.configSecret);
/** S6 gate-only rows of the same table (credential families the record redactor does not mask yet; redaction ignores them). */
export const REDACTION_GATE_PATTERNS = Object.freeze(REDACTION_TABLE.gatePatterns.map(row => Object.freeze({ ...row })));
const patterns = (text: string) => Object.freeze(REDACTION_PATTERNS.map(row => ({ kind: row.id, count: [...text.matchAll(new RegExp(row.source, row.flags))].length })).filter(row => row.count > 0).map(row => Object.freeze(row)));
/** Derived record text only: recordSource keeps legacy record coverage (Bearer); counters/standing use source (jwt's is linear, SEC-6/6b F39).
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
  checkCommandChars: number; checkIdChars: number; openIssues: number; openIssueChars: number; handoffTaskIdChars: number; handoffSummaryChars: number;
  handoffArtifacts: number; handoffArtifactNameChars: number; handoffOpenQuestions: number; handoffOpenQuestionChars: number; sharedNotes: number; sharedNoteChars: number; lessons: number; lessonTitleChars: number; lessonBodyChars: number; lessonFieldChars: number; promptBytes: number }
const reportText = (maxLength: number) => ({ type: 'string', maxLength });
const reportObject = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, required, properties });
/** S4B-2: one lesson claim. Under a strict (OpenAI) schema every property is required, so cause/correction become nullable; the validator is the floor. */
const lessonSchema = (l: ReportLimits, strictSchema: boolean) => {
  const field = { ...reportText(l.lessonFieldChars), minLength: 1 }, nullable = { type: ['string', 'null'], minLength: 1, maxLength: l.lessonFieldChars };
  return reportObject({ kind: { type: 'string', enum: LESSON_KINDS }, title: { ...reportText(l.lessonTitleChars), minLength: 1 }, body: { ...reportText(l.lessonBodyChars), minLength: 1 },
    cause: strictSchema ? nullable : field, correction: strictSchema ? nullable : field }, strictSchema ? ['kind', 'title', 'body', 'cause', 'correction'] : ['kind', 'title', 'body']);
};
export function createFinalReportJsonSchema(l: ReportLimits, strictSchema: boolean) {
  const texts = (maxItems: number, chars: number) => ({ type: 'array', maxItems, items: reportText(chars) });
  const schema = reportObject({ schemaVersion: { type: 'integer', const: 1 }, summary: reportText(l.summaryChars), changedFiles: texts(l.changedFiles, l.changedFileChars),
    // Owner D5a typed check: an `acceptance` check whose last outcome is not `passed` refuses the task; untyped/exploratory checks stay claims.
    checks: { type: 'array', maxItems: l.checks, items: reportObject({ command: reportText(l.checkCommandChars), outcome: { type: 'string', enum: ['passed', 'failed', 'not-run', 'unknown'] },
      checkId: { ...reportText(l.checkIdChars), minLength: 1 }, role: { type: 'string', enum: CHECK_ROLES } }, ['command', 'outcome']) },
    openIssues: texts(l.openIssues, l.openIssueChars), handoff: reportObject({ toTask: reportText(l.handoffTaskIdChars), summary: reportText(l.handoffSummaryChars),
      artifacts: { type: 'array', maxItems: l.handoffArtifacts, items: reportObject({ name: reportText(l.handoffArtifactNameChars), digest: { type: 'string', pattern: '^[a-f0-9]{64}$' } }) },
      openQuestions: texts(l.handoffOpenQuestions, l.handoffOpenQuestionChars) }, ['summary', 'artifacts', 'openQuestions']), sharedNotes: texts(l.sharedNotes, l.sharedNoteChars),
    exit: reportObject({ schemaVersion: { type: 'integer', const: 1 }, kind: { type: 'string', const: 'needs-input' },
      question: { ...reportText(l.handoffOpenQuestionChars), minLength: 1 } }),
    lessons: { type: 'array', maxItems: l.lessons, items: lessonSchema(l, strictSchema) },
  }, ['schemaVersion', 'summary', 'changedFiles', 'checks', 'openIssues']);
  if (strictSchema) {
    // OpenAI strict schemas require all properties. Null is transport-only and becomes absence before sealing.
    const handoff = schema.properties.handoff as ReturnType<typeof reportObject>;
    handoff.required = Object.keys(handoff.properties); handoff.properties.toTask = { type: ['string', 'null'], maxLength: l.handoffTaskIdChars };
    schema.properties.handoff = { anyOf: [handoff, { type: 'null' }] }; schema.required = Object.keys(schema.properties);
    schema.properties.exit = { anyOf: [schema.properties.exit, { type: 'null' }] };
    schema.properties.lessons = { anyOf: [schema.properties.lessons, { type: 'null' }] };
    const check = (schema.properties.checks as { items: ReturnType<typeof reportObject> }).items;
    check.required = Object.keys(check.properties); check.properties.checkId = { type: ['string', 'null'], minLength: 1, maxLength: l.checkIdChars };
    check.properties.role = { type: ['string', 'null'], enum: [...CHECK_ROLES, null] };
  }
  return schema;
}
interface HandoffNote { toTask?: string; summary: string; artifacts: { name: string; digest: string }[]; openQuestions: string[] }
const CHECK_ROLES = ['acceptance', 'exploratory'], LESSON_KINDS = ['fact', 'lesson'];
type Lesson = { kind: 'fact'; title: string; body: string } | { kind: 'lesson'; title: string; body: string; cause: string; correction: string }
interface FinalReport { schemaVersion: 1; summary: string; changedFiles: string[]; openIssues: string[];
  checks: { command: string; outcome: 'passed' | 'failed' | 'not-run' | 'unknown'; checkId?: string; role?: 'acceptance' | 'exploratory' }[];
  handoff?: HandoffNote; sharedNotes?: string[]; lessons?: Lesson[]; exit?: { schemaVersion: 1; kind: 'needs-input'; question: string } }
type FinalReportResult = { status: 'reported'; report: FinalReport; lessons?: 'invalid' } | { status: 'unavailable'; reason: 'invalid' | 'oversized' | 'missing' | 'unsupported' };
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
  // S4B-2: a lesson needs a non-empty title and body; a `lesson` also its cause and correction, a `fact` carries neither (never coerced).
  const lessonText = (v: unknown, max: number): v is string => text(v, max) && v.trim().length > 0;
  const lessonOk = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v) && (v as Record<string, unknown>).kind === 'lesson'
    ? object(v, ['kind', 'title', 'body', 'cause', 'correction']) && lessonText(v.title, l.lessonTitleChars) && lessonText(v.body, l.lessonBodyChars)
      && lessonText(v.cause, l.lessonFieldChars) && lessonText(v.correction, l.lessonFieldChars)
    : object(v, ['kind', 'title', 'body']) && v.kind === 'fact' && lessonText(v.title, l.lessonTitleChars) && lessonText(v.body, l.lessonBodyChars);
  const lessonsOk = (v: unknown) => Array.isArray(v) && v.length <= l.lessons && v.every(lessonOk);
  const needsInput = (v: unknown) => object(v, ['schemaVersion', 'kind', 'question']) && v.schemaVersion === 1 && v.kind === 'needs-input'
    && text(v.question, l.handoffOpenQuestionChars) && v.question.trim().length > 0;
  if (!object(value, ['schemaVersion', 'summary', 'changedFiles', 'checks', 'openIssues'], ['handoff', 'sharedNotes', 'exit', 'lessons']) || value.schemaVersion !== 1
    || !text(value.summary, l.summaryChars) || !texts(value.changedFiles, l.changedFiles, l.changedFileChars) || !texts(value.openIssues, l.openIssues, l.openIssueChars)
    || (Object.hasOwn(value, 'handoff') && !handoff(value.handoff)) || (Object.hasOwn(value, 'sharedNotes') && !texts(value.sharedNotes, l.sharedNotes, l.sharedNoteChars))
    || (Object.hasOwn(value, 'exit') && !needsInput(value.exit))
    || !Array.isArray(value.checks) || value.checks.length > l.checks || !value.checks.every(c => object(c, ['command', 'outcome'], ['checkId', 'role'])
      && (!Object.hasOwn(c, 'checkId') || (text(c.checkId, l.checkIdChars) && c.checkId.length > 0)) && (!Object.hasOwn(c, 'role') || CHECK_ROLES.includes(c.role as string))
      && text(c.command, l.checkCommandChars) && typeof c.outcome === 'string' && ['passed', 'failed', 'not-run', 'unknown'].includes(c.outcome))) return { status: 'unavailable', reason: 'invalid' };
  // S4B-2: a malformed optional `lessons` claim is dropped and marked; it never rejects the report (the claim is not work).
  const lessonsBad = Object.hasOwn(value, 'lessons') && !lessonsOk(value.lessons);
  const input = (lessonsBad ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'lessons')) : value) as unknown as FinalReport, red = (text: string, max: number) => redactText(text, secrets, max);
  const report: FinalReport = { schemaVersion: 1, summary: red(input.summary, l.summaryChars), changedFiles: input.changedFiles.map(x => red(x, l.changedFileChars)),
    checks: input.checks.map(x => ({ command: red(x.command, l.checkCommandChars), outcome: x.outcome,
      ...(x.checkId === undefined ? {} : { checkId: red(x.checkId, l.checkIdChars) }), ...(x.role === undefined ? {} : { role: x.role }) })), openIssues: input.openIssues.map(x => red(x, l.openIssueChars)),
    ...(input.handoff ? { handoff: { ...(input.handoff.toTask === undefined ? {} : { toTask: red(input.handoff.toTask, l.handoffTaskIdChars) }),
      summary: red(input.handoff.summary, l.handoffSummaryChars), artifacts: input.handoff.artifacts.map(a => ({ name: red(a.name, l.handoffArtifactNameChars), digest: red(a.digest, a.digest.length) })),
      openQuestions: input.handoff.openQuestions.map(x => red(x, l.handoffOpenQuestionChars)) } } : {}),
    ...(input.sharedNotes ? { sharedNotes: input.sharedNotes.map(x => red(x, l.sharedNoteChars)) } : {}),
    ...(input.lessons ? { lessons: input.lessons.map(x => ({ kind: x.kind, title: red(x.title, l.lessonTitleChars), body: red(x.body, l.lessonBodyChars),
      ...(x.kind === 'lesson' ? { cause: red(x.cause, l.lessonFieldChars), correction: red(x.correction, l.lessonFieldChars) } : {}) } as Lesson)) } : {}),
    ...(input.exit ? { exit: { schemaVersion: 1, kind: 'needs-input', question: red(input.exit.question.trim(), l.handoffOpenQuestionChars) } } : {}) };
  if (report.handoff && !handoff(report.handoff)) return { status: 'unavailable', reason: 'invalid' };
  return Buffer.byteLength(JSON.stringify(report)) > l.reportBytes ? { status: 'unavailable', reason: 'oversized' } : { status: 'reported', report, ...(lessonsBad ? { lessons: 'invalid' as const } : {}) };
}
/** Strict-schema transport nulls (OpenAI strict schemas require every property) become absence before validation. */
export function dropTransportNulls(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const report = value as Record<string, unknown>;
  if (report.exit === null) delete report.exit;
  if (Array.isArray(report.checks)) for (const check of report.checks as Record<string, unknown>[]) if (check && typeof check === 'object') for (const key of ['checkId', 'role']) if (check[key] === null) delete check[key];
  if (report.lessons === null) delete report.lessons;
  else if (Array.isArray(report.lessons)) for (const lesson of report.lessons as Record<string, unknown>[]) if (lesson && typeof lesson === 'object') for (const key of ['cause', 'correction']) if (lesson[key] === null) delete lesson[key];
  if (report.handoff === null) delete report.handoff;
  else if (report.handoff && typeof report.handoff === 'object' && !Array.isArray(report.handoff) && (report.handoff as Record<string, unknown>).toTask === null) delete (report.handoff as Record<string, unknown>).toTask;
}
/**
 * `final-text-json` channel: the report is the whole final answer text of a successful terminal `result` record. One fenced block that
 * is the entire text (```json … ```) is unwrapped, because models often fence JSON despite the instruction; JSON is never searched for
 * inside prose (no guessing which object is the report). A failed or empty result carries no report (`missing`); other text is `invalid`.
 */
function finalTextReport(data: Record<string, unknown>, secrets: readonly string[], limits: ReportLimits): FinalReportResult {
  if (data.subtype !== 'success' || data.is_error === true || typeof data.result !== 'string' || !data.result.trim()) return { status: 'unavailable', reason: 'missing' };
  const text = data.result.trim(), fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/.exec(text);
  let value: unknown;
  try { value = JSON.parse(fenced ? fenced[1]! : text); } catch { return { status: 'unavailable', reason: 'invalid' }; }
  dropTransportNulls(value);
  return validateFinalReport(value, secrets, limits);
}
/**
 * The report channel (registry capability) decides how the report is read; flag channels keep their native stream readers.
 * `final-text-json` terminal rule (REVISE 2730 R2): exactly one terminal `result` record, and it is the last record of the stream. No record of
 * any type is permitted after it (every real capture in tests/fixtures/native-cursor ends with its single `result`); blank lines are not records.
 * A second `result` (duplicate or contradictory, either order) or any later record makes the report `invalid`, sticky to EOF: an earlier
 * failure is never erased and an earlier report is never kept across later activity.
 */
export function finalReportCollector(provider: string, secrets: readonly string[], limits: ReportLimits, channel?: string) {
  let result: FinalReportResult = { status: 'unavailable', reason: 'missing' };
  const finalText = channel === 'final-text-json'; let terminal = false;
  return {
    observe(line: string) {
      if (finalText && terminal) { if (line.trim()) result = { status: 'unavailable', reason: 'invalid' }; return; }
      let data; try { data = JSON.parse(line) as Record<string, unknown>; } catch { return; }
      if (!data || typeof data !== 'object') return;
      if (finalText) { if (data.type === 'result') { terminal = true; result = finalTextReport(data, secrets, limits); } return; }
      if (provider === 'claude' && data.type === 'result') result = data.structured_output === undefined
        ? { status: 'unavailable', reason: 'missing' } : validateFinalReport(data.structured_output, secrets, limits);
      if (provider === 'codex' && data.type === 'item.completed') {
        const item = data.item as Record<string, unknown> | undefined;
        if (item?.type !== 'agent_message') return;
        try {
          const value = JSON.parse(String(item.text)) as unknown;
          dropTransportNulls(value);
          result = validateFinalReport(value, secrets, limits);
        }
        catch { result = { status: 'unavailable', reason: 'invalid' }; }
      }
    },
    oversized() { result = { status: 'unavailable', reason: finalText && terminal ? 'invalid' : 'oversized' }; },
    finish: () => result,
  };
}
const CLAUDE_TOOLS: Readonly<Record<string, string>> = { Read: 'read', NotebookRead: 'read', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit',
  Write: 'write', Bash: 'shell', BashOutput: 'shell', KillShell: 'shell', KillBash: 'shell', Grep: 'search', Glob: 'search', LS: 'search',
  WebFetch: 'network', WebSearch: 'network', Task: 'agent', Agent: 'agent' };
const IGNORED_SYSTEM = new Set(['thinking_tokens', 'hook_started', 'hook_response', 'hook_progress', 'compact_boundary', 'informational', 'status']);
const NATIVE_TIMESTAMP_SCALE = 1000; // Native protocol reset timestamps are Unix seconds; contract uses milliseconds.
export interface QuotaPolicy { readonly claudeRejectedStatuses: readonly string[]; readonly codexPatterns: readonly string[] }
export interface NormalizerState { readonly quotaPolicy?: QuotaPolicy; sequence: number; readonly startMs: number; cwd: string; readonly usageIds: Set<string>; readonly unmapped: Map<string, number>; readonly secrets: readonly string[] }
export function createNormalizerState(secrets: readonly string[], startMs = Date.now(), quotaPolicy?: QuotaPolicy): NormalizerState {
  return { ...(quotaPolicy ? { quotaPolicy } : {}), sequence: 0, startMs, cwd: '/workspace', usageIds: new Set(), unmapped: new Map(), secrets };
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
type Json = Record<string, unknown>;
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown) => typeof value === 'string' ? value : null;
/** One Claude Code stream-json line as typed fields: the one parser of this wire, shared by the worker normalizer and the headless model port
 * (S3-1). Pure and total: fields keep their wire values (callers bound, redact and convert); a missing or mistyped field is null. */
export type ClaudeStreamLine = { readonly kind: 'invalid'; readonly reason: 'non-json' | 'non-object' | 'blank' }
  | { readonly kind: 'init'; readonly data: Json; readonly cwd: string | null; readonly model: string | null; readonly cliVersion: string | null;
    readonly apiKeySource: string | null; readonly permissionMode: string | null; readonly tools: unknown; readonly mcpServers: unknown; readonly skills: unknown;
    readonly plugins: unknown; readonly pluginErrors: unknown }
  | { readonly kind: 'system'; readonly data: Json; readonly subtype: string }
  | { readonly kind: 'assistant'; readonly data: Json; readonly message: Json; readonly blocks: readonly Json[] }
  | { readonly kind: 'user'; readonly data: Json; readonly message: Json; readonly blocks: readonly Json[] }
  | { readonly kind: 'rate-limit'; readonly data: Json; readonly info: Json; readonly status: string | null; readonly resetsAt: unknown; readonly window: string | null;
    readonly errorCode: string | null; readonly windows: readonly (readonly [string, Json])[] }
  | { readonly kind: 'result'; readonly data: Json; readonly subtype: string; readonly isError: boolean; readonly usage: Json; readonly modelUsage: Readonly<Record<string, Json>> | null;
    readonly stopReason: string | null; readonly result: string | null; readonly apiErrorStatus: number | null; readonly errors: readonly string[] }
  | { readonly kind: 'other'; readonly data: Json; readonly type: string };
export function parseClaudeStreamLine(line: string): ClaudeStreamLine {
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { return { kind: 'invalid', reason: line.trim() ? 'non-json' : 'blank' }; }
  const data = record(parsed);
  if (!data) return { kind: 'invalid', reason: 'non-object' };
  const type = typeof data.type === 'string' ? data.type : 'untyped', subtype = typeof data.subtype === 'string' ? data.subtype : '';
  if (type === 'system' && subtype === 'init') return { kind: 'init', data, cwd: text(data.cwd), model: text(data.model), cliVersion: text(data.claude_code_version),
    apiKeySource: text(data.apiKeySource), permissionMode: text(data.permissionMode), tools: data.tools, mcpServers: data.mcp_servers, skills: data.skills,
    plugins: data.plugins, pluginErrors: data.plugin_errors };
  if (type === 'system') return { kind: 'system', data, subtype };
  if (type === 'assistant' || type === 'user') {
    const message = record(data.message) ?? {}, blocks = Array.isArray(message.content) ? message.content.map(block => record(block) ?? {}) : [];
    return type === 'assistant' ? { kind: type, data, message, blocks } : { kind: type, data, message, blocks };
  }
  if (type === 'rate_limit_event') {
    const info = record(data.rate_limit_info) ?? {};
    return { kind: 'rate-limit', data, info, status: text(info.status), resetsAt: info.resetsAt, window: text(info.rateLimitType), errorCode: text(info.errorCode),
      windows: Object.entries(record(info.unifiedWindows) ?? {}).map(([key, value]) => [key, record(value) ?? {}] as const) };
  }
  if (type === 'result') {
    const usage = record(data.modelUsage);
    return { kind: 'result', data, subtype, isError: data.is_error === true, usage: record(data.usage) ?? {},
      modelUsage: usage ? Object.fromEntries(Object.entries(usage).map(([key, value]) => [key, record(value) ?? {}])) : null,
      stopReason: text(data.stop_reason), result: text(data.result), apiErrorStatus: typeof data.api_error_status === 'number' ? data.api_error_status : null,
      errors: Array.isArray(data.errors) ? data.errors.filter((entry): entry is string => typeof entry === 'string') : [] };
  }
  return { kind: 'other', data, type };
}
/** Maps one line of Claude Code stream-json onto zero or more contract events. Thinking text and tool output content are never kept. */
export function normalizeClaudeLine(line: string, state: NormalizerState, now = Date.now()): BridgeEvent[] {
  const events: BridgeEvent[] = [];
  const emit = (kind: string, body: Record<string, unknown>) => events.push({ schemaVersion: 1, sequence: ++state.sequence, atMs: Math.max(0, now - state.startMs), kind, ...body });
  const miss = (type: string) => countUnmapped(state, type);
  const red = (value: unknown, max: number) => redactText(typeof value === 'string' ? value : '', state.secrets, max);
  const parsed = parseClaudeStreamLine(line), data = parsed.kind === 'invalid' ? {} : parsed.data;
  if (parsed.kind === 'invalid') { if (parsed.reason !== 'blank') miss(parsed.reason); return events; }
  if (parsed.kind === 'init') {
    if (parsed.cwd !== null) state.cwd = parsed.cwd;
    emit('session.started', { provider: 'claude', model: parsed.model?.slice(0, 128) ?? null, cliVersion: parsed.cliVersion?.slice(0, 64) ?? null });
  } else if (parsed.kind === 'system') { if (!IGNORED_SYSTEM.has(parsed.subtype)) miss(`system:${parsed.subtype}`); }
  else if (parsed.kind === 'assistant') {
    const message = parsed.message;
    const id = typeof message.id === 'string' ? message.id : null, usage = (message.usage ?? null) as Record<string, unknown> | null;
    // All messages of one API response share its id; count their usage once.
    if (id && usage && !state.usageIds.has(id)) {
      state.usageIds.add(id);
      emit('usage', { tokens: { input: num(usage.input_tokens), output: num(usage.output_tokens), cacheRead: num(usage.cache_read_input_tokens),
        cacheWrite: num(usage.cache_creation_input_tokens), thinking: null } });
    }
    for (const block of parsed.blocks) {
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
  } else if (parsed.kind === 'user') {
    for (const block of parsed.blocks) {
      if (block.type !== 'tool_result') continue;
      emit('tool.result', { toolId: String(block.tool_use_id ?? '').slice(0, 96), status: block.is_error === true ? 'error' : 'ok',
        bytes: Buffer.byteLength(typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '')) });
    }
  } else if (parsed.kind === 'rate-limit') {
    const info = parsed.info, resetsAt = parsed.resetsAt;
    if (parsed.status !== null && state.quotaPolicy?.claudeRejectedStatuses.includes(parsed.status)) {
      const resetsAtMs = typeof resetsAt === 'number' && Number.isSafeInteger(resetsAt * NATIVE_TIMESTAMP_SCALE) && resetsAt >= 0 ? resetsAt * NATIVE_TIMESTAMP_SCALE : null;
      emit('quota-exhausted', { source: 'claude-rate-limit', resetsAtMs, ...(parsed.window !== null ? { window: red(parsed.window, 32) } : {}) });
    }
    for (const [window, value] of parsed.windows) {
      const utilization = typeof value.utilization === 'number' ? Math.min(1, Math.max(0, value.utilization)) : null;
      if (utilization !== null) emit('quota', { window: window.slice(0, 32), utilization, resetsAtMs: typeof value.resetsAt === 'number' ? Math.round(value.resetsAt * NATIVE_TIMESTAMP_SCALE) : null,
        status: String(info.status ?? 'unknown').slice(0, 32) });
    }
  } else if (parsed.kind === 'result') {
    const subtype = parsed.subtype, limit = { error_max_turns: 'max-turns', error_max_budget_usd: 'budget', error_max_structured_output_retries: 'structured-output' }[subtype];
    if (limit) emit('limit', { limit, detail: subtype });
    const usage = parsed.usage, details = record(usage.output_tokens_details) ?? {};
    const usage_ = parsed.modelUsage, models = Object.values(usage_ ?? {});
    emit('session.ended', { outcome: subtype === 'success' && !parsed.isError ? 'success' : limit ? 'limit' : 'error', turns: num(data.num_turns),
      durationMs: num(data.duration_ms), apiDurationMs: typeof data.duration_api_ms === 'number' ? num(data.duration_api_ms) : null,
      costUsd: typeof data.total_cost_usd === 'number' && Number.isFinite(data.total_cost_usd) && data.total_cost_usd >= 0 ? data.total_cost_usd : null,
      costBasis: typeof models[0]?.costBasis === 'string' ? String(models[0].costBasis).slice(0, 32) : null,
      tokens: { input: num(usage.input_tokens), output: num(usage.output_tokens), cacheRead: num(usage.cache_read_input_tokens), cacheWrite: num(usage.cache_creation_input_tokens),
        thinking: typeof details.thinking_tokens === 'number' ? num(details.thinking_tokens) : null },
      permissionDenials: Array.isArray(data.permission_denials) ? data.permission_denials.length : 0,
      // Every model the session used (exact ids as keys), so the host can compare them with the admitted model (WORKER-CURRENCY-1).
      ...(usage_ ? { models: Object.keys(usage_).sort().slice(0, 16).map(key => key.slice(0, 128)) } : {}) });
  } else miss(parsed.type);
  return events;
}
const CODEX_KNOWN = new Set(['thread.started', 'turn.started', 'item.updated']);
const CODEX_CHANGE_KINDS: Readonly<Record<string, 'write' | 'edit'>> = { add: 'write', update: 'edit', delete: 'edit' };
/** Changes attributed per file_change item; the rest are counted as unmapped, never silently dropped (Astra 2066 R3). */
const CODEX_MAX_CHANGES = 512;
/** Codex state beyond the shared normalizer state: seen tool items (by native id) and running token totals for the summary. */
export interface CodexNormalizerState { readonly calls: Set<string>; turns: number; measured: boolean; readonly tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; thinking: number | null };
  /** The first `thread.started.thread_id`, untrusted: the client-model reader validates it before it names a file. */
  threadId: string | null }
export function createCodexState(): CodexNormalizerState { return { calls: new Set(), turns: 0, measured: false, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: null }, threadId: null }; }
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
  if (type === 'thread.started' && codex.threadId === null && typeof data.thread_id === 'string') codex.threadId = data.thread_id;
  const errorText = type === 'turn.failed' ? record(data.error)?.message : type === 'error' ? data.message
    : type === 'item.completed' && record(data.item)?.type === 'error' ? record(data.item)?.message : null;
  if (typeof errorText === 'string' && state.quotaPolicy?.codexPatterns.some(pattern => new RegExp(pattern, 'i').test(errorText))) {
    emit('quota-exhausted', { source: 'codex-text', resetsAtMs: null });
  }
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
        apiDurationMs: null, costUsd: null, costBasis: null, tokens: codex.measured ? { ...codex.tokens } : null, permissionDenials: 0 });
      return;
    }
    const cached = num(usage.cached_input_tokens), written = num(usage.cache_write_input_tokens);
    // OpenAI input totals include cache reads and cache writes (Codex rust-v0.163.0 `parses_cache_write_token_usage`: 100 = 40 + 60); the
    // contract counts both apart, like Claude's cache_read/cache_creation.
    const tokens = { input: Math.max(0, num(usage.input_tokens) - cached - written), output: num(usage.output_tokens), cacheRead: cached, cacheWrite: written,
      thinking: typeof usage.reasoning_output_tokens === 'number' ? num(usage.reasoning_output_tokens) : null };
    if (type === 'turn.completed') {
      emit('usage', { tokens }); codex.measured = true;
      codex.tokens.input += tokens.input; codex.tokens.output += tokens.output; codex.tokens.cacheRead += tokens.cacheRead; codex.tokens.cacheWrite += tokens.cacheWrite;
      if (tokens.thinking !== null) codex.tokens.thinking = (codex.tokens.thinking ?? 0) + tokens.thinking;
    }
    emit('session.ended', { outcome: type === 'turn.completed' ? 'success' : 'error', turns: codex.turns, durationMs: Math.max(0, now - state.startMs),
      apiDurationMs: null, costUsd: null, costBasis: null, tokens: { ...codex.tokens }, permissionDenials: 0 });
  } else if (!CODEX_KNOWN.has(type)) miss(type);
}
/** Mirrored `providers.json` `limits.clientModelReport`: bounds for reading the model a client resolved from its own session log (owner Q4 2026-10-23). */
export interface ClientModelReportLimits { readonly pollMs: number; readonly waitMs: number; readonly maxFileBytes: number; readonly maxLineBytes: number; readonly maxEntries: number }
export type ClientModelRead = Readonly<{ status: 'found'; model: string; cliVersion: string | null; contexts: number }> | Readonly<{ status: 'absent' | 'unsafe' | 'oversized' | 'invalid' }>;
const CODEX_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/**
 * The model the Codex client resolved for `threadId`: the first `turn_context.payload.model` of its rollout log
 * `<sessions>/YYYY/MM/DD/rollout-<time>-<thread_id>.jsonl` (Codex 0.163.0), plus `session_meta.payload.cli_version`; nothing else is kept.
 * The walk never follows a symbolic link and is bounded by entries; the read is bounded by bytes and per line; a partial last line is not read.
 * The worker runs as the same user and can rewrite this log, so the result is client-reported evidence, never verification.
 */
export async function readCodexRolloutModel(sessions: string, threadId: string, limits: ClientModelReportLimits): Promise<ClientModelRead> {
  if (!CODEX_THREAD_ID.test(threadId)) return { status: 'invalid' };
  try { const root = await lstat(sessions); if (!root.isDirectory()) return { status: 'unsafe' }; }
  catch (error) { return (error as { code?: unknown }).code === 'ENOENT' ? { status: 'absent' } : { status: 'unsafe' }; }
  const suffix = `-${threadId}.jsonl`, files: string[] = []; let entries = 0;
  const walk = async (dir: string, depth: number): Promise<ClientModelRead | null> => {
    const names = (await readdir(dir)).sort(); entries += names.length;
    if (entries > limits.maxEntries) return { status: 'oversized' };
    for (const name of names) {
      const path = join(dir, name), stat = await lstat(path);
      if (depth < 3) { const result = stat.isDirectory() ? await walk(path, depth + 1) : null; if (result) return result; }
      else if (name.startsWith('rollout-') && name.endsWith(suffix)) { if (!stat.isFile()) return { status: 'unsafe' }; files.push(path); }
    }
    return null;
  };
  const walked = await walk(sessions, 0);
  if (walked) return walked;
  if (files.length !== 1) return { status: files.length ? 'invalid' : 'absent' };
  const handle = await open(files[0]!, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) return { status: 'unsafe' };
    const buffer = Buffer.allocUnsafe(limits.maxFileBytes + 1); let length = 0;
    for (let read = -1; read !== 0 && length < buffer.length; length += read) read = (await handle.read(buffer, length, buffer.length - length, length)).bytesRead;
    const end = Math.min(length, limits.maxFileBytes);
    let model: string | null = null, cliVersion: string | null = null, contexts = 0;
    for (let start = 0, newline = buffer.indexOf(10, 0); newline >= 0 && newline < end; start = newline + 1, newline = buffer.indexOf(10, start)) {
      if (newline - start > limits.maxLineBytes) continue;
      let line: Record<string, unknown> | null = null;
      try { line = record(JSON.parse(buffer.toString('utf8', start, newline))); } catch { continue; }
      const payload = record(line?.payload);
      if (line?.type === 'session_meta' && cliVersion === null && typeof payload?.cli_version === 'string') cliVersion = payload.cli_version;
      else if (line?.type === 'turn_context' && ++contexts === 1) model = typeof payload?.model === 'string' && payload.model ? payload.model : null;
    }
    return model !== null ? { status: 'found', model, cliVersion, contexts } : { status: length > limits.maxFileBytes ? 'oversized' : contexts ? 'invalid' : 'absent' };
  } finally { await handle.close(); }
}
/** Client-model readers by the registry `eventStream` (data), each with the native label its unmapped causes carry; `clientHome` is the CLI's home. */
const CLIENT_MODEL_READERS: Readonly<Record<string, { readonly label: string; readonly read: (clientHome: string, codex: CodexNormalizerState, limits: ClientModelReportLimits) => Promise<ClientModelRead> | null }>> = {
  'codex-exec-json': { label: 'codex-rollout', read: (clientHome, codex, limits) => codex.threadId === null ? null : readCodexRolloutModel(join(clientHome, 'sessions'), codex.threadId, limits) },
};
const validLimits = (limits: ClientModelReportLimits | undefined): limits is ClientModelReportLimits => !!limits
  && [limits.pollMs, limits.waitMs, limits.maxFileBytes, limits.maxLineBytes, limits.maxEntries].every(value => Number.isSafeInteger(value) && value > 0);
/**
 * `client-reported` capability (owner Q4 2026-10-23): exactly one `session.started` per worker, carrying only the redacted model and client version.
 * The log is polled while the worker runs (bounded by `pollMs`/`waitMs`) so the name is read near turn start, then read once more at the end: a
 * missing, unsafe or oversized log yields a start without a model plus an unmapped cause; later turn contexts are counted unmapped, never a second start.
 */
export function createClientModelReport(stream: string, provider: string, clientHome: string, limits: ClientModelReportLimits | undefined, state: NormalizerState,
  codex: CodexNormalizerState, push: (events: BridgeEvent[]) => void) {
  const reader = Object.hasOwn(CLIENT_MODEL_READERS, stream) && validLimits(limits) ? CLIENT_MODEL_READERS[stream]! : null, startMs = Date.now();
  let emitted = false, inflight: Promise<void> | null = null;
  const emit = (model: string | null, cliVersion: string | null) => { emitted = true;
    push([{ schemaVersion: 1, sequence: ++state.sequence, atMs: Math.max(0, Date.now() - state.startMs), kind: 'session.started', provider, model, cliVersion }]); };
  const read = async (): Promise<ClientModelRead | null> => { try { return await reader!.read(clientHome, codex, limits!); } catch { return { status: 'unsafe' }; } };
  const accept = (result: ClientModelRead | null) => {
    const model = result?.status === 'found' ? redactText(result.model, state.secrets, 128) : '';
    if (model && result?.status === 'found') emit(model, result.cliVersion === null ? null : redactText(result.cliVersion, state.secrets, 64) || null);
    return emitted;
  };
  const timer = reader ? setInterval(() => {
    if (emitted || inflight) return;
    if (Date.now() - startMs > limits!.waitMs) { clearInterval(timer); return; }
    inflight = read().then(result => { if (accept(result)) clearInterval(timer); }).finally(() => { inflight = null; });
  }, limits!.pollMs) : undefined;
  timer?.unref();
  return {
    async finish() {
      clearInterval(timer); await inflight;
      if (!reader) { if (!emitted) { emit(null, null); countUnmapped(state, 'client-model-report:unsupported'); } return; }
      const result = await read();
      if (!emitted && !accept(result)) { emit(null, null); countUnmapped(state, `${reader.label}:${result === null ? 'thread' : result.status === 'found' ? 'invalid' : result.status}`); return; }
      if (result?.status === 'found' && result.contexts > 1) countUnmapped(state, `${reader.label}:turn_context`, result.contexts - 1);
    },
  };
}
/** Cursor `tool_call` keys (cursor-agent stream-json: documented readToolCall/writeToolCall/function, observed editToolCall). Unknown keys stay
 * visible as `other` calls and are also counted as unmapped, so a new native tool is never silently misclassified. */
const CURSOR_TOOLS: Readonly<Record<string, string>> = { readToolCall: 'read', editToolCall: 'edit', writeToolCall: 'write', function: 'other' };
/** Cursor state beyond the shared normalizer state: seen tool calls, derived turns, the byte size of the thinking segment in progress and whether the terminal `result` was seen. */
export interface CursorNormalizerState { readonly calls: Set<string>; turns: number; thinkingBytes: number; ended: boolean }
export function createCursorState(): CursorNormalizerState { return { calls: new Set(), turns: 0, thinkingBytes: 0, ended: false }; }
/** A Cursor usage counter is measured only as a safe non-negative integer (strict, Cursor-only: the shared `num` keeps Claude/Codex bytes unchanged). */
const cursorCounter = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
/**
 * Maps one line of `cursor-agent --print --output-format stream-json` onto contract events. Shapes follow the real cursor-agent
 * 2026.10.19-6bbf2c4 streams (tests/fixtures/native-cursor): system/init, user, thinking delta|completed, tool_call started|completed,
 * assistant, result. Cursor reports no turn count, cost or per-model usage: turns are derived (assistant message events), cost is null.
 * Thinking text and tool output are never kept; this function never throws (observation must not change execution).
 */
export function normalizeCursorLine(line: string, state: NormalizerState, cursor: CursorNormalizerState, now = Date.now()): BridgeEvent[] {
  const events: BridgeEvent[] = [];
  try { mapCursorLine(line, state, cursor, now, events); }
  catch { countUnmapped(state, 'cursor-invalid'); }
  return events;
}
function mapCursorLine(line: string, state: NormalizerState, cursor: CursorNormalizerState, now: number, events: BridgeEvent[]): void {
  const emit = (kind: string, body: Record<string, unknown>) => events.push({ schemaVersion: 1, sequence: ++state.sequence, atMs: Math.max(0, now - state.startMs), kind, ...body });
  const miss = (type: string) => countUnmapped(state, type);
  const red = (value: unknown, max: number) => redactText(typeof value === 'string' ? value : '', state.secrets, max);
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { if (line.trim()) miss('non-json'); return; }
  const data = record(parsed);
  if (!data) { miss('non-object'); return; }
  const type = typeof data.type === 'string' ? data.type : 'untyped', subtype = typeof data.subtype === 'string' ? data.subtype : '';
  if (type === 'system' && subtype === 'init') {
    if (typeof data.cwd === 'string') state.cwd = data.cwd;
    emit('session.started', { provider: 'cursor', model: typeof data.model === 'string' ? data.model.slice(0, 128) : null, cliVersion: null });
  } else if (type === 'system') miss(`system:${subtype}`);
  else if (type === 'user') return; // the echoed task prompt: known, never kept
  else if (type === 'thinking') {
    if (subtype === 'delta') cursor.thinkingBytes += Buffer.byteLength(typeof data.text === 'string' ? data.text : '');
    else if (subtype === 'completed') { emit('message', { role: 'assistant', textBytes: cursor.thinkingBytes, thinking: true, excerpt: '' }); cursor.thinkingBytes = 0; }
    else miss(`thinking:${subtype}`);
  } else if (type === 'assistant') {
    cursor.turns++;
    const message = record(data.message);
    for (const block of Array.isArray(message?.content) ? message.content as unknown[] : []) {
      const entry = record(block);
      if (entry?.type === 'text') emit('message', { role: 'assistant', textBytes: Buffer.byteLength(typeof entry.text === 'string' ? entry.text : ''), thinking: false, excerpt: red(entry.text, 240) });
      else miss(`assistant:${String(entry?.type ?? 'unknown')}`);
    }
  } else if (type === 'tool_call') {
    const call = record(data.tool_call), rawId = typeof data.call_id === 'string' ? data.call_id : '';
    // The tool is the one object-valued key; toolCallId, startedAtMs and hookAdditionalContexts are scalar or array metadata.
    const key = call ? Object.keys(call).find(name => record(call[name]) !== null) : undefined;
    if (!call || !rawId || key === undefined || (subtype !== 'started' && subtype !== 'completed')) { miss(`tool_call:${subtype || 'invalid'}`); return; }
    const entry = record(call[key])!, args = record(entry.args);
    const toolId = rawId.length <= 64 && /^[A-Za-z0-9_.:-]+$/.test(rawId) && red(rawId, 96) === rawId ? rawId : `h${createHash('sha256').update(rawId).digest('hex').slice(0, 40)}`;
    if (!cursor.calls.has(rawId)) {
      cursor.calls.add(rawId);
      const known = Object.hasOwn(CURSOR_TOOLS, key);
      if (!known) miss(`tool_call:${key}`);
      const fn = key === 'function' ? red(entry.name, 64) : '';
      const path = relative(args?.path, state.cwd);
      emit('tool.call', { toolId, name: fn || red(key, 64) || 'unknown', toolClass: known ? CURSOR_TOOLS[key] : 'other', target: path === null ? null : red(path, 256) || null, detail: null });
    }
    if (subtype === 'completed') {
      // A missing result is unknown, never success; any result without a `success` object is an error.
      const result = record(entry.result);
      if (!result) miss('tool_call:result-missing');
      else emit('tool.result', { toolId, status: Object.hasOwn(result, 'success') ? 'ok' : 'error', bytes: Buffer.byteLength(JSON.stringify(result)) });
    }
  } else if (type === 'result') {
    // One terminal result per session (REVISE 2730 R2): a later one is counted, never a second end that would override the first.
    if (cursor.ended) { miss('result:duplicate'); return; }
    cursor.ended = true;
    // A missing, malformed or incomplete usage record is unknown, never a measured zero (REVISE 2730 R1): all four counters or none.
    const usage = record(data.usage);
    const counts = usage ? [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens].map(cursorCounter) : null;
    const [input, output, cacheRead, cacheWrite] = counts ?? [];
    const measured = input != null && output != null && cacheRead != null && cacheWrite != null;
    if (!measured && data.usage !== undefined) miss('usage-invalid');
    emit('session.ended', { outcome: subtype === 'success' && data.is_error !== true ? 'success' : 'error', turns: cursor.turns,
      durationMs: num(data.duration_ms), apiDurationMs: typeof data.duration_api_ms === 'number' ? num(data.duration_api_ms) : null, costUsd: null, costBasis: null,
      tokens: measured ? { input, output, cacheRead, cacheWrite, thinking: null } : null,
      permissionDenials: 0 });
  } else miss(type);
}
/** Normalizers by the registry `eventStream` capability (data), so a new adapter id with a known stream format needs no code change. */
const STREAM_NORMALIZERS: Readonly<Record<string, (state: NormalizerState, codex: CodexNormalizerState) => (line: string) => BridgeEvent[]>> = {
  'claude-code-stream-json': state => line => normalizeClaudeLine(line, state),
  'codex-exec-json': (state, codex) => line => normalizeCodexLine(line, state, codex),
  'cursor-agent-stream-json': state => { const cursor = createCursorState(); return line => normalizeCursorLine(line, state, cursor); },
};
/**
 * Splits a native stdout stream into lines and normalizes each onto contract events (normalizer chosen by the registry `eventStream`). Observation never changes execution:
 * a normalizer or delivery fault is counted as unmapped and never thrown into the child process listeners (Astra 2066 R2).
 */
export function createNativeLineObserver(stream: string, state: NormalizerState, codex: CodexNormalizerState, push: (events: BridgeEvent[]) => void, report?: ReturnType<typeof finalReportCollector>) {
  let pending = ''; let skipping = false;
  const decoder = new TextDecoder();
  const normalize = Object.hasOwn(STREAM_NORMALIZERS, stream) ? STREAM_NORMALIZERS[stream]!(state, codex) : null;
  const normalizeLine = (line: string) => {
    try {
      if (Buffer.byteLength(line) > 1_048_576) { report?.oversized(); countUnmapped(state, 'oversized-line'); return; }
      report?.observe(line);
      if (normalize) push(normalize(line));
      else if (line.trim()) countUnmapped(state, `${stream}-event`);
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
function eventChannel(socketPath: string, capability: string, maxQueued = 4000, batch = 64) {
  const queue: BridgeEvent[] = []; let dropped = 0, sending: Promise<void> = Promise.resolve();
  const post = (events: BridgeEvent[]) => new Promise<void>(resolve => {
    const body = events.map(event => JSON.stringify(event)).join('\n') + '\n';
    const request = httpRequest({ socketPath, path: '/events', method: 'POST', timeout: 5000,
      headers: { authorization: capability, 'content-type': 'application/x-ndjson', 'content-length': Buffer.byteLength(body) } }, response => { response.resume(); response.on('end', resolve); response.on('error', () => resolve()); });
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
  readonly discovery: { readonly requiredFlags: readonly string[]; readonly hiddenProbes: readonly { readonly args: readonly string[]; readonly refusal: string }[];
    readonly checkout: { readonly hiddenPaths: readonly string[] } | null } | null;
  readonly promptChannel: 'claude-system-prompt' | 'codex-instructions-file' | 'inline';
  readonly structuredReport: { readonly flag: string; readonly channel: 'inline-json' | 'schema-file' } | { readonly flag: null; readonly channel: 'final-text-json' } | null;
  readonly modelUsageEvidence: 'session-events' | 'session-start-name' | 'client-reported' | 'none';
  readonly eventStream: 'claude-code-stream-json' | 'codex-exec-json' | 'cursor-agent-stream-json';
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
/** A hidden-parser probe holds only when the CLI refuses its invalid value with exactly the registered refusal. */
const refuses = (run: (args: readonly string[]) => string, probe: { readonly args: readonly string[]; readonly refusal: string }) => {
  try { run(probe.args); return false; }
  catch (error) { return String((error as { stderr?: unknown }).stderr ?? '').includes(probe.refusal); }
};
/** Required flags and hidden-parser probes are registry data; the parser refusal must match exactly. Disabled discovery also runs every
 * registered discovery probe, so a CLI that would silently ignore an unknown suppression key fails here, before credentials exist. */
export function nativePreflightCapabilities(capabilities: NativeWorkerCapabilities,
  preflight: { schemaVersion: number; cliVersion: string; helpArgs: readonly string[]; requiredFlags: readonly string[]; discovery?: string }, run: (args: readonly string[]) => string): boolean {
  const version = run(['--version']).trim(), help = run(preflight.helpArgs).split(/[\s,=]+/);
  if (preflight.schemaVersion !== 1 || version !== preflight.cliVersion || preflight.requiredFlags.some(flag => {
    if (help.includes(flag)) return false;
    const probe = capabilities.maxTurns?.hiddenHelpProbe;
    return !(flag === capabilities.maxTurns?.flag && probe && refuses(run, probe));
  }) || (preflight.discovery === 'disabled' && (!capabilities.discovery || capabilities.discovery.hiddenProbes.some(probe => !refuses(run, probe))))) throw new Error();
  // A flagless channel (`final-text-json`) needs no help flag: the schema rides in the prompt.
  const report = capabilities.structuredReport;
  return report !== null && (report.flag === null || help.includes(report.flag));
}
export function nativeReportArguments(capabilities: NativeWorkerCapabilities, schema: string): string[] {
  const report = capabilities.structuredReport;
  return report && report.flag !== null ? [report.flag, report.channel === 'inline-json' ? schema : '/tmp/deckent-report-schema.json'] : [];
}
/** Flagless report channel: the instruction and schema appended to the task prompt (the last argv element); null for flag channels. */
export function nativeReportInstruction(capabilities: NativeWorkerCapabilities, schema: string): string | null {
  return capabilities.structuredReport?.channel === 'final-text-json' ? '### report:final-text-json@1\nWhen the task is finished, your final answer must be '
    + 'your final report: exactly one JSON object that matches the JSON Schema below, with no other text before or after it, no Markdown and no code fence.\n' + schema : null;
}

async function main() {
  const socketPath = '/run/deckent-connection.sock';
  const capability = await readFile('/run/deckent-bootstrap.key', 'utf8');
  if (!/^[a-f0-9]{64}$/u.test(capability)) throw new Error();
  const payload = await new Promise<string>((resolve, reject) => {
    const request = get({ socketPath, path: '/bootstrap', headers: { authorization: capability }, timeout: 10000 }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (part: string) => { text += part; if (Buffer.byteLength(text) > 131072) request.destroy(new Error()); });
      response.on('error', reject); response.on('end', () => response.statusCode === 200 ? resolve(text) : reject(new Error()));
    });
    request.on('error', reject); request.on('timeout', () => request.destroy(new Error()));
  });
  const setup = JSON.parse(payload) as { schemaVersion: number; provider: string; capabilities: NativeWorkerCapabilities; home: string; file: string;
    quotaPolicy?: QuotaPolicy; credential: Record<string, unknown>; credentialEnvironment?: string; environment: Record<string, string>;
    limits: { connections: number; idleMs: number; clientModelReport?: ClientModelReportLimits };
    finalReport?: { schemaVersion: 1; limits: ReportLimits };
    dependencyContext?: { text: string; sha256: string; maxBytes: number };
    preflight?: { schemaVersion: number; cliVersion: string; helpArgs: string[]; requiredFlags: string[]; discovery?: string };
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
    const extra = nativeReportArguments(setup.capabilities, schema), instruction = nativeReportInstruction(setup.capabilities, schema);
    if (setup.capabilities.structuredReport?.channel === 'schema-file') await writeFile('/tmp/deckent-report-schema.json', schema, { mode: 0o600, flag: 'wx' });
    const end = argv.lastIndexOf('--'); argv.splice(end < 0 ? argv.length : end, 0, ...extra);
    // The prompt is the argument after the end-of-options marker; without that shape the instruction cannot be delivered (no report).
    if (instruction !== null) { if (argv.at(-2) === '--') argv[argv.length - 1] += '\n\n' + instruction; else reportSupported = false; }
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
  const state = createNormalizerState([...secretValues(setup.credential), proxy], Date.now(), setup.quotaPolicy);
  const channel = eventChannel(socketPath, capability);
  const codex = createCodexState();
  if (setup.capabilities.modelUsageEvidence === 'none') channel.push([{ schemaVersion: 1, sequence: ++state.sequence, atMs: 0, kind: 'session.started', provider: setup.provider, model: null, cliVersion: null }]);
  const clientModel = setup.capabilities.modelUsageEvidence === 'client-reported' ? createClientModelReport(setup.capabilities.eventStream, setup.provider, authRoot,
    setup.limits.clientModelReport, state, codex, events => channel.push(events)) : null;
  const capture = (part: Buffer) => { bytes += part.length; tail = (tail + part.toString('utf8')).slice(-65536); };
  const report = setup.finalReport && reportSupported ? finalReportCollector(setup.provider, state.secrets, setup.finalReport.limits, setup.capabilities.structuredReport?.channel) : undefined;
  const lineObserver = createNativeLineObserver(setup.capabilities.eventStream, state, codex, events => channel.push(events), report);
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
  await clientModel?.finish();
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
