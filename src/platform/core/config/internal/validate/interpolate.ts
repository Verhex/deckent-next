import { isRecord } from '#platform/core/utils/index.js';

/** Composition supplies the authorized secret backend; no file-format or keyring policy lives here. */
export type SecretResolver = (reference: string) => Promise<string | undefined>;
export interface SecretResolution<T> { readonly config: T; readonly secretPaths: readonly string[]; readonly references: readonly string[] }
/** References are resolved once per load and never retained in the effective-config cache. */
export async function resolveConfigSecrets<T>(config: T, resolver: SecretResolver, missing: (key: string) => void = () => {}): Promise<SecretResolution<T>> {
  const resolved = new Map<string, string | undefined>(), secretPaths: string[] = [];
  async function visit(value: unknown, path: string): Promise<unknown> {
    if (typeof value === 'string') {
      const key = value.match(/^\$DECK:([A-Z_][A-Z0-9_]*)$/)?.[1];
      if (!key) return value;
      if (!resolved.has(key)) {
        let secret: string | undefined;
        try { secret = await resolver(key); } catch { throw new Error('SECRET_RESOLUTION_FAILED'); }
        if (secret !== undefined && typeof secret !== 'string') throw new Error('SECRET_RESOLVER_RESULT_INVALID');
        resolved.set(key, secret);
      }
      const secret = resolved.get(key);
      if (secret === undefined || secret === '') { missing(key); return value; }
      secretPaths.push(path); return secret;
    }
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (let i = 0; i < value.length; i++) result.push(await visit(value[i], `${path}/${i}`));
      return result;
    }
    if (isRecord(value)) {
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [key, child] of Object.entries(value)) result[key] = await visit(child, `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`);
      return result;
    }
    return value;
  }
  const output = await visit(config, '') as T;
  return { config: output, secretPaths: Object.freeze(secretPaths), references: Object.freeze([...resolved.keys()]) };
}
