import { CONFIG_SCHEMA_VERSION } from '#platform/core/common/index.js';
import { t, resolveLocale, type Locale } from '#platform/core/i18n/index.js';
import { ErrorRegistry } from '#platform/core/errors/index.js';
import { assertSafeKeys, type JsonRecord } from '#platform/core/utils/index.js';
import { ConfigValidationError, type ConfigWarning } from './issues.js';

/** Versioned compatibility law, never selectable product policy. */
export const RETIRED_CONFIG_FIELDS = Object.freeze(['mode', 'spawn_backend', 'auth_mode', 'providers', 'live_trace'] as const);
export function assertNoRetiredConfigFields(input: JsonRecord, locale: Locale = resolveLocale()): void {
  const issues = RETIRED_CONFIG_FIELDS.filter(key => Object.hasOwn(input, key)).map(path => ({ path, reason: 'CONFIG_FIELD_RETIRED' }));
  if (issues.length) throw new ConfigValidationError(issues, locale);
}
/** Unversioned layers use today's contract. Explicit v3 layers normalize on read; the next governed write persists v4. */
export function versionedConfig(input: JsonRecord, onWarning?: (warning: ConfigWarning) => void, locale: Locale = resolveLocale()): JsonRecord {
  assertSafeKeys(input);
  const version = Object.hasOwn(input, 'schema_version') ? input['schema_version'] : CONFIG_SCHEMA_VERSION;
  if (version !== CONFIG_SCHEMA_VERSION && version !== 3) throw ErrorRegistry.createError('CONFIG_VERSION_UNSUPPORTED', { params: { version: String(version) } });
  const next = structuredClone(input);
  if (version === 3) {
    for (const key of RETIRED_CONFIG_FIELDS) if (Object.hasOwn(next, key)) {
      delete next[key];
      // Only key names are reported; the retired provider selection may contain interpolated credentials.
      onWarning?.({ code: 'CONFIG_FIELD_RETIRED', path: key, message: t('config.surface.fieldRetired', { key }, locale) });
    }
  } else assertNoRetiredConfigFields(next, locale);
  return { ...next, schema_version: CONFIG_SCHEMA_VERSION };
}
