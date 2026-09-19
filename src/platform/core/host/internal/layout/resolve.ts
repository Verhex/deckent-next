import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';
import { PRODUCT_LAYOUT_REGISTRY as registry } from '#platform/core/common/index.js';

export type ProductResource = keyof typeof registry.resources;
export interface ProductLayoutInput {
  readonly projectRoot: string;
  readonly bootstrapConfigPath?: string;
  readonly root?: string;
  readonly platform?: 'posix' | 'win32';
  readonly resources?: Partial<Record<ProductResource, string>>;
}
export interface ProductLayout {
  readonly schemaVersion: number;
  readonly revision: string;
  readonly bootstrapConfigPath: string;
  readonly root: string;
  readonly platform: 'posix' | 'win32';
  readonly resources: Readonly<Record<ProductResource, string>>;
}
export class LayoutError extends Error {
  constructor(readonly code: 'LAYOUT_ROOT_INVALID' | 'LAYOUT_RESOURCE_INVALID' | 'LAYOUT_RESOURCE_UNKNOWN') { super(code); }
}
const hasControl = (value: string) => [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const isFixedResource = (resource: string) => registry.fixedResources.includes(resource);
function relativeResource(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes(':') || hasControl(value) || /[<>|?*]/.test(value)
    || value.split('/').some(segment => !segment || segment === '.' || segment === '..' || /[. ]$/.test(segment)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) throw new LayoutError('LAYOUT_RESOURCE_INVALID');
}
/** Pure location resolution: no mkdir, migration, environment reads or implicit cwd. */
export function resolveProductLayout(input: ProductLayoutInput): ProductLayout {
  const platform = input.platform ?? 'posix', api = platform === 'win32' ? win32 : posix;
  if (!api.isAbsolute(input.projectRoot) || hasControl(input.projectRoot)
    || (input.root !== undefined && (!api.isAbsolute(input.root) || hasControl(input.root)))) throw new LayoutError('LAYOUT_ROOT_INVALID');
  const root = api.normalize(input.root ?? api.join(input.projectRoot, registry.rootName));
  const resources = { ...registry.resources };
  for (const [key, value] of Object.entries(input.resources ?? {})) {
    if (isFixedResource(key)) throw new LayoutError('LAYOUT_RESOURCE_INVALID');
    if (!Object.hasOwn(resources, key)) throw new LayoutError('LAYOUT_RESOURCE_UNKNOWN');
    relativeResource(value); resources[key as ProductResource] = value;
  }
  for (const value of Object.values(resources)) {
    relativeResource(value);
  }
  const bootstrapConfigPath = input.bootstrapConfigPath ?? api.join(input.projectRoot, registry.rootName,
    resources[registry.bootstrapResource as ProductResource]);
  if (!api.isAbsolute(bootstrapConfigPath) || hasControl(bootstrapConfigPath)) throw new LayoutError('LAYOUT_ROOT_INVALID');
  const normalizedBootstrapConfigPath = api.normalize(bootstrapConfigPath);
  const resourcePath = (resource: ProductResource) => {
    if (resource === registry.bootstrapResource) return normalizedBootstrapConfigPath;
    const relative = isFixedResource(resource) ? registry.resources[resource] : resources[resource];
    return api.join(isFixedResource(resource) ? api.dirname(normalizedBootstrapConfigPath) : root, ...relative.split('/'));
  };
  const seen = new Set<string>();
  for (const resource of Object.keys(resources) as ProductResource[]) {
    const path = resourcePath(resource);
    const identity = platform === 'win32' ? path.toLowerCase() : path;
    if (seen.has(identity)) throw new LayoutError('LAYOUT_RESOURCE_INVALID');
    seen.add(identity);
  }
  const snapshot = { bootstrapConfigPath: normalizedBootstrapConfigPath, schemaVersion: registry.schemaVersion, root, platform, resources: Object.freeze(resources) };
  const revision = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  return Object.freeze({ ...snapshot, revision });
}
/** Callers retain this snapshot throughout one operation; config reload produces a new snapshot. */
export function productResourcePath(layout: ProductLayout, resource: ProductResource): string {
  if (!Object.hasOwn(layout.resources, resource)) throw new LayoutError('LAYOUT_RESOURCE_UNKNOWN');
  if (resource === registry.bootstrapResource) return layout.bootstrapConfigPath;
  const relative = isFixedResource(resource) ? registry.resources[resource] : layout.resources[resource]; relativeResource(relative);
  const api = layout.platform === 'win32' ? win32 : posix;
  return api.join(isFixedResource(resource) ? api.dirname(layout.bootstrapConfigPath) : layout.root, ...relative.split('/'));
}
