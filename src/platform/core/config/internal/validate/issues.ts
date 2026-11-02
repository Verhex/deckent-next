import { z } from 'zod';
import { persistedIssueCode } from '#platform/core/validate/index.js';
import { DeckentError, ErrorRegistry } from '#platform/core/errors/index.js';
import { t, resolveLocale, type Locale } from '#platform/core/i18n/index.js';
import { terminalSafeText } from '#platform/core/output/index.js';
import type { StandardSchemaV1 } from '#platform/core/validate/index.js';
/** `allowed`: the values an enum takes (BeUser KER-05: the refusal names them, so the next attempt can succeed). */
export interface ConfigIssue { readonly path: string; readonly reason: string; readonly allowed?: readonly string[] }
export const configIssue = (prefix: readonly (string | number)[], issue: StandardSchemaV1.Issue): ConfigIssue => {
  const detail = issue as StandardSchemaV1.Issue & { code?: string; values?: readonly unknown[]; params?: { legacyCode?: string } };
  const path = [...prefix, ...(issue.path ?? []).map(part => typeof part === 'object' ? part.key : part)].map(String).join('.');
  const code = path === 'schema_version' && detail.code === 'invalid_union' ? 'invalid_literal' : persistedIssueCode(detail);
  return { path, reason: code === 'too_big' && path.startsWith('beuser.limits.') ? 'BEUSER_LIMITS_UNAVAILABLE' : code,
    ...(code === 'invalid_enum_value' ? { allowed: detail.values?.map(String) ?? [] } : {}) };
};
/** Preserve v3's multiple numeric diagnostics: v4 stops at nonfinite input before checking bounds. */
export function configIssues(prefix: readonly (string | number)[], schema: unknown, issues: readonly StandardSchemaV1.Issue[], input: unknown): ConfigIssue[] {
  if (!issues.length) return [{ path: prefix.join('.'), reason: 'SECTION_INVALID' }];
  return issues.flatMap(issue => {
    const mapped = configIssue(prefix, issue), detail = issue as StandardSchemaV1.Issue & { code?: string; expected?: string };
    if (detail.code !== 'invalid_type' || detail.expected !== 'number') return [mapped];
    let node = schema, value = input;
    const parts = (issue.path ?? []).map(part => typeof part === 'object' ? part.key : part);
    const unwrap = (candidate: unknown): unknown => {
      const seen = new Set<unknown>();
      while (!seen.has(candidate)) {
        seen.add(candidate);
        if (candidate instanceof z.ZodDefault || candidate instanceof z.ZodPrefault || candidate instanceof z.ZodOptional || candidate instanceof z.ZodNullable || candidate instanceof z.ZodReadonly) candidate = candidate.unwrap();
        else if (candidate instanceof z.ZodPipe) candidate = candidate.in;
        else break;
      }
      return candidate;
    };
    for (const part of parts) {
      node = unwrap(node);
      node = node instanceof z.ZodObject && typeof part !== 'symbol' ? node.shape[part] : node instanceof z.ZodArray ? node.element : node instanceof z.ZodRecord ? node.valueType : undefined;
      value = value !== null && typeof value === 'object' ? (value as Record<PropertyKey, unknown>)[part] : undefined;
    }
    node = unwrap(node);
    if (!(node instanceof z.ZodNumber) || value !== Infinity && value !== -Infinity) return [mapped];
    const reasons: string[] = node.meta()?.['type'] === 'integer' || node.isInt ? ['invalid_type'] : [];
    for (const check of node.def.checks ?? []) {
      const definition = check._zod.def as { check: string; value?: number };
      if (definition.check === 'greater_than' && value < definition.value!) reasons.push('too_small');
      if (definition.check === 'less_than' && value > definition.value!) reasons.push('too_big');
    }
    return reasons.length ? reasons.map(reason => ({ ...mapped, reason })) : [mapped];
  });
}
export interface ConfigWarning { readonly code: string; readonly path: string; readonly message: string }
/** A reason that is a registered error code renders as `CODE: <localized sentence>`; common schema reasons are localized and other issue names stay literal. */
const issueReason = (reason: string, locale: Locale): string => { const entry = ErrorRegistry.get(reason, locale); return entry ? `${reason}: ${entry.message}` : reason === 'unrecognized_keys' ? t('config.issue.unrecognized', {}, locale) : reason === 'invalid_type' ? t('config.issue.type', {}, locale) : reason; };
export class ConfigValidationError extends DeckentError {
  constructor(public readonly issues: readonly ConfigIssue[], locale: Locale = resolveLocale(), files: Readonly<Record<string, string>> = {}) {
    const localize = (target: Locale) => ({ message: t('error.CONFIG_VALIDATION', { issues: issues.map(i => t('config.valueInvalid', { path: files[i.path] ? `${files[i.path]}: ${i.path}` : i.path, reason: i.allowed?.length
      ? t('config.issue.allowed', { values: i.allowed.map(value => terminalSafeText(value)).join(', ') }, target) : issueReason(i.reason, target) }, target)).join('; ') }, target) });
    super('CONFIG_VALIDATION', localize(locale).message, undefined, undefined, undefined, undefined, undefined, 'config', undefined, localize);
    this.name = 'ConfigValidationError';
  }
}
