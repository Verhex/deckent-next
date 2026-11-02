import { assertNoRetiredConfigFields } from './version.js';
import { CORE_SCHEMA, configSections, type DeckentConfig } from '../schema.js';
import { ConfigValidationError, configIssues, type ConfigIssue, type ConfigWarning } from './issues.js';
import { isRecord, assertSafeKeys } from '#platform/core/utils/index.js';
import { type Locale } from '#platform/core/i18n/index.js';
import { assertConfigSecretPolicies, assertHostLeavingSecretReferences } from './secret-policy.js';
import { validateStandardSchemaSync } from '#platform/core/validate/index.js';

export function validateConfig(input: unknown, locale: Locale = 'en'): { config: DeckentConfig; warnings: ConfigWarning[] } {
  if (!isRecord(input)) throw new ConfigValidationError([{ path: '$', reason: 'OBJECT_REQUIRED' }], locale);
  assertConfigSecretPolicies(input, locale);
  assertHostLeavingSecretReferences(input, locale);
  assertSafeKeys(input);
  assertNoRetiredConfigFields(input, locale);
  const issues: ConfigIssue[] = [], warnings: ConfigWarning[] = [];
  const installation = input['installation'];
  if (isRecord(installation) && installation['sharedRegistrationId'] != null && ![5, 6].includes(Number(input['schema_version']))) {
    issues.push({ path: 'schema_version', reason: 'CONFIG_VERSION_UNSUPPORTED' });
  }
  const core = Object.fromEntries(Object.entries(input).filter(([key]) => Object.hasOwn(CORE_SCHEMA.shape, key)));
  const result = CORE_SCHEMA.safeParse(core);
  // A missing Run bound follows the effective service capacity; an authored bound stays independent.
  if (result.success && (!isRecord(input['runRuntime']) || input['runRuntime']['maxConcurrentRuns'] === undefined)) {
    result.data.runRuntime.maxConcurrentRuns = result.data.service.maxConcurrentExecutions;
  }
  if (!result.success) issues.push(...configIssues([], CORE_SCHEMA, result.error.issues, core));
  const config = structuredClone(input);
  if (result.success) Object.assign(config, result.data);
  const sections = configSections();
  for (const [key, value] of Object.entries(input)) {
    if (Object.hasOwn(CORE_SCHEMA.shape, key)) continue;
    const schema = sections.get(key)?.schema;
    if (schema) {
      const parsed = validateStandardSchemaSync(schema, value);
      if (parsed.status === 'invalid') issues.push(...configIssues([key], schema, parsed.issues, value));
      else if (parsed.status === 'async') issues.push({ path: key, reason: 'SECTION_INVALID' });
      else config[key] = parsed.value;
    } else issues.push({ path: key, reason: 'unrecognized_keys' });
  }
  for (const [key, { schema, options }] of sections) {
    if (Object.hasOwn(input, key) || options.optional) continue;
    const parsed = validateStandardSchemaSync(schema, {});
    if (parsed.status === 'invalid') issues.push(...configIssues([key], schema, parsed.issues, {}));
    else if (parsed.status === 'async') issues.push({ path: key, reason: 'SECTION_INVALID' });
    else config[key] = parsed.value;
  }
  if (issues.length) throw new ConfigValidationError(issues, locale);
  for (const [key, section] of sections) {
    if (Object.hasOwn(config, key)) section.options.validateValue?.(config[key]);
  }
  assertConfigSecretPolicies(config, locale);
  assertHostLeavingSecretReferences(config, locale);
  return { config: config as DeckentConfig, warnings };
}
