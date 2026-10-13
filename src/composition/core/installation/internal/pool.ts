import { lstat } from 'node:fs/promises';
import { openInstallationPoolStore, openLocalIntegrityAuthority, readLocalOsIdentity } from '#adapters/index.js';
import { AuditApplication, configuredInstallationPool, installExecutionPool, type InstallationPoolResult } from '#engine/index.js';
import { inspectProductFile, productResourcePath, SystemTrustedClock, type ConfigLoadOptions } from '#platform/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { assertConfiguredInstallationIdentity } from './apply.js';

/** Local installer custody only; no policy approval, migration, runtime or new installation. */
export async function installConfiguredExecutionPool(projectRoot: string, scopeId: string, apply: boolean, options: ConfigLoadOptions = {},
  callerUid: number | undefined = process.getuid?.()): Promise<InstallationPoolResult> {
  const unavailable = (reason: NonNullable<InstallationPoolResult['reason']>): InstallationPoolResult => ({ schemaVersion: 1, scopeId, status: 'unavailable', reason, configured: null });
  let config;
  try { config = await loadComposedConfig(projectRoot, { ...options, heal: false }); }
  catch (error) { if ((error as { code?: string }).code === 'CONFIG_VALIDATION') return unavailable('invalid-config'); throw error; }
  const layout = config.productLayout;
  const owns = async (path: string) => { try { const stat = await lstat(path); return callerUid !== undefined && stat.isFile() && !stat.isSymbolicLink() && stat.uid === callerUid; } catch { return false; } };
  if (!(await owns(productResourcePath(layout, 'policy')) && await owns(productResourcePath(layout, 'bindings')))) return unavailable('not-owner');
  const pool = configuredInstallationPool(config.admission);
  if (!pool) return unavailable('invalid-admission');
  if (apply) await assertConfiguredInstallationIdentity(projectRoot);
  let path: string;
  try { path = await inspectProductFile(layout, 'ledger', ['-wal', '-shm', '-journal']); }
  catch (error) { return { ...unavailable((error as { code?: string }).code === 'MANAGED_FILE_MISSING' ? 'ledger-missing' : 'ledger-unavailable'), configured: pool }; }
  const store = await openInstallationPoolStore(path, config.storage.sqlite), principal = readLocalOsIdentity(), clock = new SystemTrustedClock();
  const input = { scopeId, owner: true, pool, store, principal, now: () => clock.sample().wallMs };
  const preview = await installExecutionPool({ ...input, apply: false, policyRevision: '', record: () => { throw new Error('INSTALLER_PREVIEW_WRITE'); } });
  if (!apply || preview.status !== 'preview') return preview;
  const policy = await createLayoutPolicySource(layout, callerUid!, config.inspection.policyMaxBytes).load();
  const integrity = await openLocalIntegrityAuthority(layout, config.approvals.keyFile, true);
  return installExecutionPool({ ...input, apply: true, policyRevision: policy.revision,
    record: (auditStore, event) => { new AuditApplication(auditStore, integrity).record(event); } });
}
