import type { ErrorDefinition, ErrorDefinitions } from './definition.js';

/** Merges the core table with the family fragments in order. A code defined twice fails closed and names both sources:
 * a family fragment may add codes or take over a code moved out of the core table, never redefine one silently. */
export function mergeErrorDefinitions(fragments: readonly (readonly [source: string, definitions: ErrorDefinitions])[]): ErrorDefinitions {
  const merged: Record<string, ErrorDefinition> = {};
  const owners = new Map<string, string>();
  for (const [source, definitions] of fragments) for (const code of Object.keys(definitions)) {
    const owner = owners.get(code);
    if (owner !== undefined) throw new Error(['ERROR_REGISTRY_DUPLICATE', code, owner, source].join(':'));
    owners.set(code, source);
    merged[code] = definitions[code]!;
  }
  return Object.freeze(merged);
}
