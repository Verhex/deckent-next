import { z } from 'zod';
import { ErrorRegistry } from '#platform/index.js';

/** No credential or token can become Dockerfile text, an argument or retained evidence. */
export function workerSourceUrl(value: string, proxy = false): string {
  let url: URL;
  try { url = new URL(value); } catch { throw ErrorRegistry.createError('WORKER_IMAGE_SOURCE_INSECURE'); }
  if (url.username || url.password || url.search || url.hash) throw ErrorRegistry.createError('WORKER_IMAGE_SOURCE_CREDENTIALS_REFUSED');
  if (url.protocol !== 'https:' && !(proxy && url.protocol === 'http:')) throw ErrorRegistry.createError('WORKER_IMAGE_SOURCE_INSECURE');
  return value;
}
const version = z.string().regex(/^r[1-9][0-9]*-\d{8}$/u);
const id = z.string().regex(/^[a-z0-9]{1,32}$/u);
const installer = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('npm'), package: z.string().regex(/^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/u) }).strict(),
  z.object({ kind: z.literal('vendor-script'), url: z.string().url(), home: z.string().regex(/^\/opt\/[a-z0-9][\w.-]{0,63}$/u), bin: z.array(z.string().regex(/^[a-z0-9][\w.-]{0,63}$/u)).nonempty() }).strict(),
]);
export const layeredWorkerRecipeSchema = z.object({ schemaVersion: z.literal(3), repository: z.string().min(1), baseRepository: z.string().min(1),
  imageVersion: version, previousVersion: version.nullable(), npmRegistry: z.string().url(),
  base: z.object({ image: z.string().min(1), apt: z.array(z.string().regex(/^[a-z0-9][a-z0-9+.-]*$/u)).nonempty() }).strict(),
  providers: z.array(z.object({ id, installer, command: z.string().regex(/^[a-z0-9][\w.-]{0,63}$/u), helpArgs: z.array(z.string()), requiredFlags: z.array(z.string()) }).strict()).nonempty(),
}).strict();
export type LayeredWorkerRecipe = z.infer<typeof layeredWorkerRecipeSchema>;
export type WorkerInstallInput = Readonly<{ kind: 'npm'; package: string; version: string } | { kind: 'vendor-script'; url: string; sha256: string }>;
export type WorkerBuildPlan = Readonly<{ schemaVersion: 1; imageVersion: string; previousVersion: string | null; base: { image: string; pull: boolean }; buildTimeoutMs: number;
  images: readonly (readonly string[])[]; providers: Readonly<Record<string, WorkerInstallInput>>; npmRegistry: string; proxy: string | null; refreshKey: string }>;
export type WorkerImageSources = Readonly<{ baseImage?: string | null; proxy?: string | null; installerUrls?: Readonly<Record<string, string>> }>;

/** Pure plan from bounded adapter observations. Every selected provider needs a concrete version/hash before Docker can run. */
export function planWorkerImage(input: Readonly<{ recipe: LayeredWorkerRecipe; imageVersion: string; previousVersion: string | null; selected: readonly string[];
  resolved: Readonly<Record<string, WorkerInstallInput>>; npmRegistry: string; sources?: WorkerImageSources; buildTimeoutMs: number; refreshKey: string; pull: boolean }>): WorkerBuildPlan {
  const { recipe, resolved } = input;
  if (!Number.isSafeInteger(input.buildTimeoutMs) || input.buildTimeoutMs <= 0 || !/^[0-9]{1,16}$/u.test(input.refreshKey)) throw ErrorRegistry.createError('WORKER_PLAN_INVALID');
  workerSourceUrl(input.npmRegistry);
  if (input.sources?.proxy) workerSourceUrl(input.sources.proxy, true);
  if (!input.selected.length || new Set(input.selected).size !== input.selected.length) throw ErrorRegistry.createError('WORKER_PLAN_INVALID');
  for (const name of input.selected) {
    const provider = recipe.providers.find(entry => entry.id === name), value = resolved[name];
    if (!provider || !value || provider.installer.kind !== value.kind) throw ErrorRegistry.createError('WORKER_IMAGE_VERSIONS_UNRESOLVABLE');
    if (value.kind === 'npm' && (provider.installer.kind !== 'npm' || value.package !== provider.installer.package || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u.test(value.version))) throw ErrorRegistry.createError('WORKER_IMAGE_VERSIONS_UNRESOLVABLE');
    if (value.kind === 'vendor-script') {
      workerSourceUrl(value.url);
      if (!/^[a-f0-9]{64}$/u.test(value.sha256)) throw ErrorRegistry.createError('WORKER_IMAGE_VERSIONS_UNRESOLVABLE');
    }
  }
  return { schemaVersion: 1, imageVersion: input.imageVersion, previousVersion: input.previousVersion,
    base: { image: input.sources?.baseImage ?? recipe.base.image, pull: input.pull }, buildTimeoutMs: input.buildTimeoutMs,
    images: input.selected.map(name => [name]), providers: Object.fromEntries(input.selected.map(name => [name, resolved[name]!])),
    npmRegistry: input.npmRegistry, proxy: input.sources?.proxy ?? null, refreshKey: input.refreshKey };
}
