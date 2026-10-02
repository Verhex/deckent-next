import { authorizeConfigWrite, AuditApplication, type ConfigAuthorityPort } from '#engine/index.js';
import type { VerifiedPrincipal } from '#domain/index.js';
import type { ResolvedConfig, ProductLayout } from '#platform/index.js';
import { openSqliteAuditStore, openLocalIntegrityAuthority } from '#adapters/index.js';
interface ConfigAuthorityContext {
  readonly principal: VerifiedPrincipal; readonly document: unknown; readonly config: ResolvedConfig;
  readonly layout: ProductLayout; readonly path: () => Promise<string>;
}
/** Trusted composition supplies local scope verification; adapters own policy/audit persistence behind the application's ports. */
export function createConfigFileAuthority(loadContext: (scopeId: string) => Promise<ConfigAuthorityContext>): ConfigAuthorityPort {
  return {
    async authorize(input) { const context = await loadContext(input.scopeId); return authorizeConfigWrite(context.document, context.principal, input); },
    async audit(event) {
      const context = await loadContext(event.scopeId);
      const store = await openSqliteAuditStore(await context.path(), context.config.storage.sqlite, 'forbid');
      try { new AuditApplication(store, await openLocalIntegrityAuthority(context.layout, context.config.approvals.keyFile, true)).record(event); }
      finally { store.close(); }
    },
  };
}
