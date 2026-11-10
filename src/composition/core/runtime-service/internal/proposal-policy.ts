import { lstat } from 'node:fs/promises';
import { AuditApplication, upgradeFirstRunProposalRules } from '#engine/index.js';
import { openLocalIntegrityAuthority, openSqliteAuditStore, readLocalOsIdentity } from '#adapters/index.js';
import { prepareProductFile, productResourcePath, SystemTrustedClock } from '#platform/index.js';
import type { AuditEvent } from '#domain/index.js';
import { contextPolicySource } from '#composition/core/policy/index.js';
import type { loadComposedConfig } from '#composition/core/root/index.js';

/** Owner S6 (2026-11-09): the service start's v20 proposal rules on an installed first-run policy of the OS person who owns both authority files (no card,
 * no witness: the owner's decision; audited and archived, once). A hand-built policy is anchored on the configured service scope; another owner or an unreadable archive changes nothing. */
export async function upgradeProposalPolicyAtStart(config: Awaited<ReturnType<typeof loadComposedConfig>>, uid: number | undefined = process.getuid?.()) {
  const layout = config.productLayout, identity = readLocalOsIdentity();
  const owns = async (path: string) => { try { const stat = await lstat(path); return uid !== undefined && stat.isFile() && !stat.isSymbolicLink() && stat.uid === uid; } catch { return false; } };
  if (!await owns(productResourcePath(layout, 'policy')) || !await owns(productResourcePath(layout, 'bindings'))) return 'skipped' as const;
  const writer = contextPolicySource({ layout, config, ownerUid: uid }), history = await writer.authorityHistory();
  return history === null ? 'skipped' as const : upgradeFirstRunProposalRules(writer, { person: { issuer: identity.issuer, subject: identity.subject }, history, scopeId: config.service.identity?.scopeId, now: () => new SystemTrustedClock().sample().wallMs,
    openAudit: async () => {
      const store = await openSqliteAuditStore(await prepareProductFile(layout, 'ledger', ['-wal', '-shm', '-journal']), config.storage.sqlite, 'allow');
      try { const audit = new AuditApplication(store, await openLocalIntegrityAuthority(layout, config.approvals.keyFile, true)); return { record: (event: AuditEvent) => { audit.record(event); }, close: () => store.close() }; }
      catch (error) { store.close(); throw error; }
    } });
}
