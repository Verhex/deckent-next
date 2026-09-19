import { configSections } from '../schema.js';
import { ConfigValidationError } from './issues.js';
import { parseSecretReference } from './interpolate.js';
import type { Locale } from '#platform/core/i18n/index.js';

/** Inspect descriptors, never getters. Iterative traversal avoids recursion on authored JSON.
 * Error evidence names only the section, never a reference name or its resolved value. */
export function assertConfigSecretPolicies(input: unknown, locale?: Locale): void {
  if (!input || typeof input !== 'object') return;
  for (const [name, section] of configSections()) {
    if (section.options.secretReferences !== 'forbid') continue;
    const invalid = (reason: string): never => { throw new ConfigValidationError([{ path: name, reason }], locale); };
    const entry = Object.getOwnPropertyDescriptor(input, name);
    if (!entry) continue;
    if (!('value' in entry)) invalid('SECRET_SECTION_INVALID');
    const pending: { value: unknown; exit?: boolean }[] = [{ value: entry.value }];
    const ancestors = new Set<object>();
    while (pending.length) {
      const item = pending.pop()!, value = item.value;
      if (typeof value === 'string') {
        if (parseSecretReference(value)) invalid('SECRET_REFERENCE_FORBIDDEN');
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
  }
}
