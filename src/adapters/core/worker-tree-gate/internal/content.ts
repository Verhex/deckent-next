import GATE from './gate.json' with { type: 'json' };
import { posix } from 'node:path';
import { REDACTION_CONFIG_SECRET, REDACTION_PATTERNS } from '#platform/index.js';
import { createGlobMatcher } from '#adapters/core/workspace-read/index.js';

/** The content rules are the redaction table's rows marked `gate` (versioned registry data); `source` is the table's precise expression. */
export const WORKER_TREE_PATTERN_RULES = Object.freeze(REDACTION_PATTERNS.filter(row => row.gate === true));
const patternRules = WORKER_TREE_PATTERN_RULES.map(row => ({ id: row.id, expression: new RegExp(row.source, row.flags.replace('g', '')) }));
const archives = GATE.archives.map(row => ({ kind: row.kind, offset: row.offset, bytes: Buffer.from(row.hex, 'hex') }));
const config = REDACTION_CONFIG_SECRET, keys = config.keys.join('|');
const configFiles = config.files.map(glob => createGlobMatcher(glob.toLowerCase()));
const assignment = new RegExp(config.assignmentSource.replaceAll('{keys}', keys), config.flags);
const element = new RegExp(config.elementSource.replaceAll('{keys}', keys), config.flags);
const placeholders = config.placeholders.map(source => new RegExp(source, 'iu')), yamlBlock = new RegExp(GATE.yamlBlockIndicator, 'u');
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
export const isConfigFile = (path: string) => configFiles.some(match => match(posix.basename(path).toLowerCase()));
const isPlaceholder = (value: string) => { const text = value.trim(); return text.length < config.minValueLength || placeholders.some(expression => expression.test(text)); };
/** The value a YAML block scalar (`key: |`, `key: >-`) carries: its next non-empty line; none at all is unreadable and counts as a value. */
function blockValue(text: string, end: number): string | null {
  const line = text.slice(end).split(/\r\n|\r|\n/u).slice(1).find(candidate => candidate.trim() !== '');
  return line === undefined ? null : line;
}
/** `config-secret`: a secret-named key (the redaction vocabulary) assigned a non-placeholder literal in a config-like file. */
export function configSecretHit(text: string): boolean {
  for (const match of text.matchAll(assignment)) {
    const quoted = match[2] ?? match[3], bare = match[4];
    if (quoted !== undefined) { if (!isPlaceholder(quoted)) return true; continue; }
    if (bare === undefined) continue;
    if (yamlBlock.test(bare)) { const value = blockValue(text, match.index + match[0].length); if (value === null || !isPlaceholder(value)) return true; continue; }
    if (!isPlaceholder(bare)) return true;
  }
  for (const match of text.matchAll(element)) if (!isPlaceholder(match[2] ?? '')) return true;
  return false;
}
/** The first content rule any reading matches: a gated table row, then `config-secret` for config-like files. */
export function contentRule(path: string, texts: readonly string[], configLike = isConfigFile(path)): string | null {
  const row = patternRules.find(rule => texts.some(text => rule.expression.test(text)));
  if (row) return row.id;
  return configLike && texts.some(configSecretHit) ? config.id : null;
}
