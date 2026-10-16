import GATE from './gate.json' with { type: 'json' };
import { posix } from 'node:path';
import { REDACTION_CONFIG_SECRET, REDACTION_GATE_PATTERNS, REDACTION_PATTERNS } from '#platform/index.js';
import { createGlobMatcher, type RegexRunner } from '#adapters/core/workspace-read/index.js';

/**
 * The content rules: the redaction table's rows marked `gate`, plus its gate-only rows (credential families the record redactor does not mask
 * yet). Versioned registry data; `source` is the precise expression. Every row is evaluated in the terminable regex worker (S6 regex
 * semantics): a pattern that backtracks past the scan deadline ends the scan as `incomplete`, never as a pass.
 */
export const WORKER_TREE_PATTERN_RULES = Object.freeze([...REDACTION_PATTERNS.filter(row => row.gate === true), ...REDACTION_GATE_PATTERNS]
  .map(row => Object.freeze({ id: row.id, source: row.source, flags: row.flags.replace('g', '') })));
const archives = GATE.archives.map(row => ({ kind: row.kind, offset: row.offset, bytes: Buffer.from(row.hex, 'hex') }));
const config = REDACTION_CONFIG_SECRET, keys = config.keys.join('|');
const configFiles = config.files.map(glob => createGlobMatcher(glob.toLowerCase()));
const assignment = new RegExp(config.assignmentSource.replaceAll('{keys}', keys), config.flags);
const element = new RegExp(config.elementSource.replaceAll('{keys}', keys), config.flags);
const placeholders = config.placeholders.map(source => new RegExp(source, 'iu')), envDefault = new RegExp(config.envDefaultSource, 'u');
const yamlBlock = new RegExp(GATE.yamlBlockIndicator, 'u'), yamlAlias = new RegExp(GATE.yamlAlias, 'u');
const NUL = 0;

/** Escapes a JSON or YAML parser decodes inside quoted text (`\uXXXX`, `\xHH`): a key or value written escaped reads as its decoded form. */
const unescaped = (text: string) => text.replace(/\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})/gu, (_, u?: string, x?: string) => String.fromCharCode(parseInt(u ?? x!, 16)));
/**
 * Every reading a worker's tools can take of the same bytes (parser parity, S6): UTF-8 (a BOM is just a leading character), and when the bytes
 * hold NUL — UTF-16/32 or binary — the NUL-stripped bytes (ASCII inside UTF-16/32 of either byte order) plus UTF-16 in both alignments; each
 * also with JSON/YAML escapes decoded. A rule matching any reading matches the file.
 */
export function decodedTexts(bytes: Buffer): readonly string[] {
  const texts = [bytes.toString('utf8')];
  if (bytes.includes(NUL)) texts.push(Buffer.from(bytes.filter(byte => byte !== NUL)).toString('utf8'), bytes.toString('utf16le'), bytes.subarray(1).toString('utf16le'));
  return [...new Set([...texts, ...texts.map(unescaped)])];
}
/** A compressed or archived file: the worker can extract it, the gate cannot read it the same way, so it is unscannable (fail closed). */
export function archiveKind(bytes: Buffer): string | null {
  return archives.find(row => bytes.length >= row.offset + row.bytes.length && bytes.subarray(row.offset, row.offset + row.bytes.length).equals(row.bytes))?.kind ?? null;
}
/** Config-like by name in every form a path can take (case, NFC/NFD/NFKC, Windows trailing dots/spaces): matching broadens, never narrows. */
export function isConfigFile(path: string): boolean {
  const name = posix.basename(path).toLowerCase(), forms = [name, name.normalize('NFKC'), name.normalize('NFC'), name.normalize('NFD')];
  return [...forms, ...forms.map(form => form.replace(/[. ]+$/u, ''))].some(form => configFiles.some(match => match(form)));
}
/** A placeholder is a reference or marker, never a literal; `${VAR:-default}` is judged by its default, which a shell or Compose uses. */
function isPlaceholder(value: string): boolean {
  const text = value.trim(), fallback = envDefault.exec(text);
  if (fallback) return isPlaceholder(fallback[1]!);
  return text.length < config.minValueLength || placeholders.some(expression => expression.test(text));
}
/** The value a YAML block scalar (`key: |`, `key: >-`, `key: |2-`) carries: its next non-empty line; none at all is unreadable and counts as a value. */
function blockValue(text: string, end: number): string | null {
  const line = text.slice(end).split(/\r\n|\r|\n/u).slice(1).find(candidate => candidate.trim() !== '');
  return line === undefined ? null : line;
}
/** Whether the line after an assignment is indented deeper than the assignment's own line (a YAML plain-scalar continuation). */
function continuesScalar(text: string, start: number, end: number): boolean {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1, indent = /^[ \t]*/u.exec(text.slice(lineStart))![0].length;
  const next = text.slice(end).split(/\r\n|\r|\n/u).slice(1).find(line => line.trim() !== '');
  return next !== undefined && /^[ \t]*/u.exec(next)![0].length > indent && !next.trim().startsWith('#');
}
/**
 * `config-secret`: a secret-named key (case-insensitive, the redaction vocabulary) assigned a non-placeholder literal in a config-like file.
 * The expressions are linear by construction (token-start lookbehind, classes that exclude their own start characters); a YAML alias
 * (`*name`) cannot be resolved here and counts as a value (fail closed).
 */
export function configSecretHit(text: string): boolean {
  for (const match of text.matchAll(assignment)) {
    const quoted = match[2] ?? match[3], bare = match[4];
    if (quoted !== undefined) { if (!isPlaceholder(quoted)) return true; continue; }
    if (bare === undefined) continue;
    if (yamlAlias.test(bare) && !/^\*+$/u.test(bare)) return true;
    if (yamlBlock.test(bare)) { const value = blockValue(text, match.index + match[0].length); if (value === null || !isPlaceholder(value)) return true; continue; }
    if (!isPlaceholder(bare)) return true;
    // A bare GitHub Actions expression is the whole value only when the next non-empty line does not continue the plain scalar
    // (more indented than the key's line); otherwise the continuation is part of the value and stays a hit (fail closed, Astra 2588).
    if (bare.startsWith('${{') && continuesScalar(text, match.index, match.index + match[0].length)) return true;
  }
  for (const match of text.matchAll(element)) if (!isPlaceholder(match[2] ?? '')) return true;
  return false;
}
/** The first content rule any reading matches: a pattern row (in the terminable worker), then `config-secret` for config-like files. */
const combined = [...new Set(WORKER_TREE_PATTERN_RULES.map(row => row.flags))].map(flags => ({ flags,
  source: WORKER_TREE_PATTERN_RULES.filter(row => row.flags === flags).map(row => `(?:${row.source})`).join('|') }));
export async function contentRule(runner: RegexRunner, path: string, texts: readonly string[], configLike = isConfigFile(path)): Promise<string | null> {
  // One combined expression per flag set screens the file; only a hit is attributed row by row (same rows, same flags).
  for (const group of combined) if ((await runner.match(group.source, group.flags, texts)).length) {
    for (const row of WORKER_TREE_PATTERN_RULES) if (row.flags === group.flags && (await runner.match(row.source, row.flags, texts)).length) return row.id;
  }
  return configLike && texts.some(configSecretHit) ? config.id : null;
}
