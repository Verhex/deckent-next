import { z } from 'zod';
import { text } from './schema-parts.js';
/** Owner 2026-11-11: provenance is fixed; known names only control notices. */
export const nativeBuiltinPluginPolicySchema = z.strictObject({ path: z.literal('builtin'), sourceTemplate: z.literal('{name}@builtin'),
  knownNames: z.array(text).readonly() }).readonly();
const pluginSchema = z.looseObject({ name: text, path: text, source: text });
/** Null refuses malformed, duplicate or non-builtin entries; otherwise returns previously unseen names. Both Claude guards use this rule. */
export function nativeBuiltinPlugins(value: unknown, policy: z.infer<typeof nativeBuiltinPluginPolicySchema>): readonly string[] | null {
  const parsed = z.array(pluginSchema).safeParse(value);
  if (!parsed.success) return null;
  const names = new Set<string>(), unknown: string[] = [];
  for (const plugin of parsed.data) {
    if (names.has(plugin.name) || plugin.path !== policy.path || plugin.source !== policy.sourceTemplate.replace('{name}', () => plugin.name)) return null;
    names.add(plugin.name);
    if (!policy.knownNames.includes(plugin.name)) unknown.push(plugin.name);
  }
  return unknown;
}
