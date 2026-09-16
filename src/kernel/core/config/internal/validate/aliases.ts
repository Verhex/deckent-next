import { isDeepStrictEqual } from 'node:util';
import { ErrorRegistry } from '../../../errors/index.js';
import { assertSafeKeys, isRecord, type JsonRecord } from '../../../utils/index.js';

const MODES: Readonly<Record<string, string>> = Object.freeze({ max_plan: 'performance', max5x_plan: 'balanced', pro_plan: 'economic', unlimited: 'api' });
const OUTPUT: Readonly<Record<string, string>> = Object.freeze({ standart: 'standard', explainatory: 'explanatory', quiet: 'standard', normal: 'standard' });
export function resolveMode(value: string): string { return Object.hasOwn(MODES, value) ? MODES[value]! : value; }
export function resolveOutputMode(value: string): string { return Object.hasOwn(OUTPUT, value) ? OUTPUT[value]! : value; }
export function normalizeConfigAliases(input: JsonRecord): JsonRecord {
  assertSafeKeys(input);
  const config = structuredClone(input);
  if (typeof config['mode'] === 'string') config['mode'] = resolveMode(config['mode']);
  if (typeof config['output_mode'] === 'string') config['output_mode'] = resolveOutputMode(config['output_mode']);
  if (['v1', 'v2'].includes(String(config['routing_engine']))) config['routing_engine'] = 'v3';
  for (const [oldKey, newKey] of [['outputMode', 'output_mode'], ['principal_enforce', 'enforce_principal_assurance']]) {
    if (config[oldKey!] === undefined) continue;
    const value = oldKey === 'outputMode' && typeof config[oldKey] === 'string' ? resolveOutputMode(config[oldKey]) : config[oldKey!];
    if (config[newKey!] !== undefined && !isDeepStrictEqual(value, config[newKey!])) throw ErrorRegistry.createError('CONFIG_ALIAS_CONFLICT', { params: { key: newKey! } });
    config[newKey!] = value; delete config[oldKey!];
  }
  if (config['providers'] !== undefined && !isRecord(config['providers'])) return config;
  const providers: JsonRecord = isRecord(config['providers']) ? config['providers'] : {};
  for (const [oldKey, key] of [['brain_provider', 'brain'], ['worker_provider', 'worker'], ['fallback_provider', 'fallback'], ['provider_overrides', 'overrides']]) {
    if (config[oldKey!] === undefined) continue;
    if (providers[key!] !== undefined && !isDeepStrictEqual(config[oldKey!], providers[key!])) throw ErrorRegistry.createError('CONFIG_ALIAS_CONFLICT', { params: { key: oldKey! } });
    providers[key!] = config[oldKey!]; delete config[oldKey!]; config['providers'] = providers;
  }
  return config;
}
export function versionedConfig(input: JsonRecord): JsonRecord {
  const version = input['schema_version'] ?? 1;
  if (version !== 1 && version !== 2) throw ErrorRegistry.createError('CONFIG_VERSION_UNSUPPORTED', { params: { version: String(version) } });
  return { ...normalizeConfigAliases(input), schema_version: 2 };
}
