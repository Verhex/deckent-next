import { CORE_SCHEMA, configSections, type DeckentConfig } from '../schema.js';
import { ConfigValidationError, type ConfigIssue, type ConfigWarning } from './issues.js';
import { isRecord, assertSafeKeys } from '#platform/core/utils/index.js';
import { type Locale } from '#platform/core/i18n/index.js';
import { assertConfigSecretPolicies } from './secret-policy.js';

export function validateConfig(input: unknown, locale: Locale = 'en'): { config: DeckentConfig; warnings: ConfigWarning[] } {
  if (!isRecord(input)) throw new ConfigValidationError([{ path: '$', reason: 'OBJECT_REQUIRED' }], locale);
  assertConfigSecretPolicies(input, locale);
  assertSafeKeys(input);
  const issues: ConfigIssue[] = [], warnings: ConfigWarning[] = [];
  const core = Object.fromEntries(Object.entries(input).filter(([key]) => Object.hasOwn(CORE_SCHEMA.shape, key)));
  const result = CORE_SCHEMA.safeParse(core);
  if (!result.success) issues.push(...result.error.issues.map(i => ({ path: i.path.join('.'), reason: i.code })));
  const config = structuredClone(input);
  if (result.success) Object.assign(config, result.data);
  const sections = configSections();
  for (const [key, value] of Object.entries(input)) {
    if (Object.hasOwn(CORE_SCHEMA.shape, key)) continue;
    const schema = sections.get(key)?.schema;
    if (schema) {
      const parsed = schema.safeParse(value);
      if (!parsed.success) issues.push(...parsed.error.issues.map(i => ({ path: [key, ...i.path].join('.'), reason: i.code })));
      else config[key] = parsed.data;
    } else issues.push({ path: key, reason: 'unrecognized_keys' });
  }
  for (const [key, { schema, options }] of sections) {
    if (Object.hasOwn(input, key) || options.optional) continue;
    const parsed = schema.safeParse({});
    if (!parsed.success) issues.push(...parsed.error.issues.map(i => ({ path: [key, ...i.path].join('.'), reason: i.code })));
    else config[key] = parsed.data;
  }
  if (issues.length) throw new ConfigValidationError(issues, locale);
  for (const [key, section] of sections) {
    if (Object.hasOwn(config, key)) section.options.validateValue?.(config[key]);
  }
  assertConfigSecretPolicies(config, locale);
  return { config: config as DeckentConfig, warnings };
}
