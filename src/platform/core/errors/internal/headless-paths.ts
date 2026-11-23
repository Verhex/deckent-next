import { homedir } from 'node:os';
import { sep } from 'node:path';
import { t, type Locale } from '#platform/core/i18n/index.js';
import { redactForRecord } from '#platform/core/redaction/index.js';
import { DeckentError } from './error.js';

// Only the local terminal renders these paths. They never enter the error, its params, or a transport.
const paths = new WeakMap<DeckentError, Readonly<{ chosen: string; checked?: string }>>();
export function retainHeadlessPaths(error: DeckentError, chosen: string, checked?: string) {
  paths.set(error, checked === undefined ? { chosen } : { chosen, checked });
  return error;
}
function displayPath(path: string, home: string) {
  const short = path === home || path.startsWith(home + sep) ? '~' + path.slice(home.length) : path;
  const clean = redactForRecord(short.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '?'));
  return clean.length > 240 ? clean.slice(0, 239) + '…' : clean;
}
export function localHeadlessPathDetail(error: unknown, locale: Locale, home = homedir()): string | undefined {
  if (!(error instanceof DeckentError) || error.code !== 'HEADLESS_PREFLIGHT_FAILED') return undefined;
  const cause = error.cause;
  const detail = paths.get(error) ?? (cause instanceof DeckentError && cause.code === error.code ? paths.get(cause) : undefined);
  if (!detail) return undefined;
  const chosen = displayPath(detail.chosen, home);
  return detail.checked === undefined ? t('error.headless.chosenFile', { chosen }, locale)
    : t('error.headless.executableFiles', { chosen, checked: displayPath(detail.checked, home) }, locale);
}
