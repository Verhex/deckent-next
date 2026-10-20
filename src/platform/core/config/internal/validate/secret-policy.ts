import { configSections } from '../schema.js';
import { ConfigValidationError } from './issues.js';
import { parseSecretReference } from './interpolate.js';
import type { Locale } from '#platform/core/i18n/index.js';

/** Core config values that leave the host (SEC-3, F33): the delivery commit author is published with the commit, so no layer may
 * fill it from an installation secret. Invariant in versioned code; there is deliberately no project-layer allowlist (none needed). */
const HOST_LEAVING_CONFIG_PATHS: readonly (readonly string[])[] = Object.freeze([Object.freeze(['execution', 'git', 'deliveryIdentity'])]);

/** Inspect descriptors, never getters. Iterative traversal avoids recursion on authored JSON. Returns true at the first exact reference. */
function containsSecretReference(root: unknown, invalid: (reason: string) => never): boolean {
  const pending: { value: unknown; exit?: boolean }[] = [{ value: root }];
  const ancestors = new Set<object>();
  while (pending.length) {
    const item = pending.pop()!, value = item.value;
    if (typeof value === 'string') {
      if (parseSecretReference(value)) return true;
      continue;
    }
    if (!value || typeof value !== 'object') continue;
    if (item.exit) { ancestors.delete(value); continue; }
    if (ancestors.has(value)) invalid('SECRET_SECTION_INVALID');
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (!array && prototype !== null && prototype !== Object.prototype) invalid('SECRET_SECTION_INVALID');
    ancestors.add(value); pending.push({ value, exit: true });
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string') invalid('SECRET_SECTION_INVALID');
      if (array && key === 'length') continue;
      const child = descriptors[key as string]!;
      if (!('value' in child) || !child.enumerable) invalid('SECRET_SECTION_INVALID');
      pending.push({ value: child.value });
    }
  }
  return false;
}
/** Own data property only; an accessor is refused rather than invoked. */
function ownValue(input: object, name: string, invalid: (reason: string) => never): { readonly value: unknown } | undefined {
  const entry = Object.getOwnPropertyDescriptor(input, name);
  if (!entry) return undefined;
  if (!('value' in entry)) invalid('SECRET_SECTION_INVALID');
  return { value: entry.value };
}

/** Error evidence names only the section, never a reference name or its resolved value. */
export function assertConfigSecretPolicies(input: unknown, locale?: Locale): void {
  if (!input || typeof input !== 'object') return;
  for (const [name, section] of configSections()) {
    if (section.options.secretReferences !== 'forbid') continue;
    const invalid = (reason: string): never => { throw new ConfigValidationError([{ path: name, reason }], locale); };
    const entry = ownValue(input, name, invalid);
    if (entry && containsSecretReference(entry.value, invalid)) invalid('SECRET_REFERENCE_FORBIDDEN');
  }
}
/** SEC-3 (F33): the project file is someone else's commit, so it may not pull an installation secret in any field, core or section,
 * just as a project MCP file may not (`expandMcpEntry`). Only the installation layer may hold `$DECK:NAME`. The issue names the
 * top-level field only. Run on the authored project layer before merging, so an installation value cannot mask it. */
export function assertProjectLayerSecretReferences(project: unknown, locale?: Locale): void {
  if (!project || typeof project !== 'object') return;
  for (const name of Reflect.ownKeys(project)) {
    if (typeof name !== 'string') throw new ConfigValidationError([{ path: '$', reason: 'SECRET_SECTION_INVALID' }], locale);
    const invalid = (reason: string): never => { throw new ConfigValidationError([{ path: name, reason }], locale); };
    const entry = ownValue(project, name, invalid);
    if (entry && containsSecretReference(entry.value, invalid)) invalid('SECRET_REFERENCE_PROJECT_LAYER');
  }
}
/** SEC-3 (F33): values published off the host never come from a secret reference, in any layer. Checked before resolution, so no
 * resolver is read for them. */
export function assertHostLeavingSecretReferences(input: unknown, locale?: Locale): void {
  for (const path of HOST_LEAVING_CONFIG_PATHS) {
    const invalid = (reason: string): never => { throw new ConfigValidationError([{ path: path.join('.'), reason }], locale); };
    let value: unknown = input;
    for (const segment of path) {
      if (!value || typeof value !== 'object') { value = undefined; break; }
      value = ownValue(value, segment, invalid)?.value;
    }
    if (value !== undefined && containsSecretReference(value, invalid)) invalid('SECRET_REFERENCE_LEAVES_HOST');
  }
}
