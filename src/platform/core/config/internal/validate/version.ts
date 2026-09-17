import { CONFIG_SCHEMA_VERSION } from '#platform/core/common/index.js';
import { ErrorRegistry } from '#platform/core/errors/index.js';
import { assertSafeKeys, type JsonRecord } from '#platform/core/utils/index.js';

/** An unversioned authored layer uses the current contract; no legacy value conversion. */
export function versionedConfig(input: JsonRecord): JsonRecord {
  assertSafeKeys(input);
  const version = Object.hasOwn(input, 'schema_version') ? input['schema_version'] : CONFIG_SCHEMA_VERSION;
  if (version !== CONFIG_SCHEMA_VERSION) throw ErrorRegistry.createError('CONFIG_VERSION_UNSUPPORTED', { params: { version: String(version) } });
  return { ...structuredClone(input), schema_version: CONFIG_SCHEMA_VERSION };
}
