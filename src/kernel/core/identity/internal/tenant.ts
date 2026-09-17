import { AsyncLocalStorage } from 'node:async_hooks';
import { ErrorRegistry } from '#kernel/core/errors/index.js';
import { resolveDeckentHome, type PathContext } from '#kernel/core/platform/index.js';
import { pathApi } from '#kernel/core/platform/index.js';
import { envValue } from '#kernel/core/platform/index.js';
import { validatePath } from '#kernel/core/validate/index.js';
export interface TenantContext { readonly tenantId: string; readonly isolationRoot: string; readonly createdAt: string }
const tenants = new AsyncLocalStorage<TenantContext>();
export function isValidTenantId(id: string): boolean { return /^[a-z0-9][a-z0-9-]{0,62}$/.test(id); }
export function tenantIsolationPath(projectRoot: string, tenantId: string, context: PathContext = {}): string {
  if (!isValidTenantId(tenantId)) throw ErrorRegistry.createError('E_INVALID_TENANT_ID');
  return pathApi(context.platform ?? process.platform).join(resolveDeckentHome(projectRoot, context), 'tenants', tenantId);
}
export function resolveTenant(projectRoot: string, options: PathContext & { tenantId?: string } = {}): TenantContext {
  const tenantId = options.tenantId ?? envValue(options.env ?? process.env, 'DECKENT_TENANT_ID') ?? 'local';
  if (!isValidTenantId(tenantId)) throw ErrorRegistry.createError('E_INVALID_TENANT_ID');
  return Object.freeze({ tenantId, isolationRoot: tenantIsolationPath(projectRoot, tenantId, options), createdAt: new Date().toISOString() });
}
export function resolveCallerTenant(principal: { id: string; tenantId?: string }, strict: boolean): string {
  const tenant = principal.tenantId?.trim();
  if (tenant) { if (!isValidTenantId(tenant)) throw ErrorRegistry.createError('E_INVALID_TENANT_ID'); return tenant; }
  if (strict) throw ErrorRegistry.createError('TENANT_SCOPE_UNRESOLVED');
  return 'local';
}
export function withTenant<T>(tenantId: string, projectRoot: string, fn: () => T): T { return tenants.run(resolveTenant(projectRoot, { tenantId }), fn); }
export function currentTenant(projectRoot = process.cwd()): TenantContext { return tenants.getStore() ?? resolveTenant(projectRoot); }
export function tenantPath(relativePath: string, projectRoot?: string): string { return validatePath(currentTenant(projectRoot).isolationRoot, relativePath); }
