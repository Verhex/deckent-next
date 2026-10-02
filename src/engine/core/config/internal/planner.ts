import { createDefaultConfig, validateConfig, applyConfigEnvironment, configSections } from '#platform/index.js';
import { deepMerge, isRecord, assertSafeKeys } from '#platform/index.js';
import { ConfigApplicationError, type ConfigSnapshot } from './contract.js';
import { definitionFor, configPath } from './registry.js';
import { validateAuthoredConfigOverlay, assertConfigJsonValue } from './overlay.js';
/** Pure authored-document update. Registry validates the path; full schemas validate the resulting document. */
export function planConfigChange(document: Record<string, unknown>, keyPath: string, value: unknown, unset: boolean): Record<string, unknown> {
  const path = configPath(keyPath);
  if (path[0] === 'secrets') throw new ConfigApplicationError('CONFIG_SECRET_SECTION_REFUSED');
  definitionFor(keyPath); if (!unset) assertConfigJsonValue(value, keyPath); assertSafeKeys(value);
  const next = structuredClone(document); let target: Record<string, unknown> | unknown[] = next;
  const index = (array: unknown[], part: string, append: boolean) => {
    if (!/^(0|[1-9]\d*)$/.test(part)) throw new ConfigApplicationError('CONFIG_ARRAY_INDEX_INVALID');
    const position = Number(part);
    if (!Number.isSafeInteger(position) || position < 0 || position > array.length || !append && position === array.length) throw new ConfigApplicationError('CONFIG_ARRAY_INDEX_INVALID');
    return position;
  };
  for (const part of path.slice(0, -1)) {
    const property = Array.isArray(target) ? index(target, part, false) : part;
    const parent = target as Record<string | number, unknown>, item = parent[property];
    if (item === undefined || item === null) { if (unset) return next; parent[property] = {}; }
    if (!isRecord(parent[property]) && !Array.isArray(parent[property])) throw new ConfigApplicationError('CONFIG_KEY_NOT_OBJECT');
    target = parent[property] as Record<string, unknown> | unknown[];
  }
  const last = path.at(-1)!;
  if (Array.isArray(target)) { const position = index(target, last, !unset); if (unset) target.splice(position, 1); else target[position] = structuredClone(value); }
  else if (unset) delete target[last]; else target[last] = structuredClone(value);
  validateAuthoredConfigOverlay(next); return next;
}
export function validateConfigLayers(snapshot: ConfigSnapshot, document = snapshot.document) {
  const global = snapshot.layer === 'global' ? document : snapshot.global, project = snapshot.layer === 'project' ? document : snapshot.project;
  for (const [key, section] of configSections()) section.options.validateLayers?.(global[key], project[key]);
  validateAuthoredConfigOverlay(global); validateAuthoredConfigOverlay(project);
  const checked = validateConfig(applyConfigEnvironment(deepMerge(deepMerge(createDefaultConfig(), global), project), snapshot.env));
  for (const section of configSections().values()) section.options.validateEffective?.(checked.config, snapshot.env);
  return checked;
}
