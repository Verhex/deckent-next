import { readFile, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createConfiguredRuntimeClient, startConfiguredRuntimeService } from '../../../src/index.js';
import { checkpointConfiguredAudit } from '#composition/core/audit/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { clearConfigCache, productResourcePath } from '#platform/index.js';
import { openLocalIntegrityAuthority, openSqliteAuditStore } from '#adapters/index.js';
import { AuditApplication, type AuditServiceStatus } from '#engine/index.js';
import { auditCheckpointFixture } from '../support/audit-checkpoint.js';

/** Lead-host socket test: Codex must retain this file without claiming a local socket/process result. */
it.skipIf(process.platform !== 'linux')('starts visibly degraded after tail truncation while describeService remains available', async () => {
  const f = await auditCheckpointFixture(); let host: Awaited<ReturnType<typeof startConfiguredRuntimeService>> | undefined;
  try {
    await checkpointConfiguredAudit(f.root, f.installationId, f.options);
    const configPath = join(f.root, '.deckent/config.json'), authored = JSON.parse(await readFile(configPath, 'utf8'));
    await writeFile(configPath, JSON.stringify({ ...authored, cancellation: { maxConcurrentDeliveries: 1 },
      cancellationRuntime: { scopeIds: ['s'], pollIntervalMs: 1000, failureBackoffMs: 1000 }, toolchains: { update: { atStartup: false, intervalMs: 0 } } }));
    clearConfigCache(); const config = await loadComposedConfig(f.root, f.options);
    const db = new DatabaseSync(productResourcePath(config.productLayout, 'ledger'));
    db.exec('DROP TRIGGER audit_events_no_delete; DELETE FROM audit_events'); db.close();
    const observed: AuditServiceStatus[] = [];
    host = await startConfiguredRuntimeService(f.root, { onPage() {}, onError() {}, onAuditIntegrity: status => { observed.push(status); } }, f.options);
    expect(observed[0]).toMatchObject({ status: 'degraded', verifications: [{ status: 'truncated' }] });
    expect(host.auditIntegrity.status).toBe('degraded');
    expect(await createConfiguredRuntimeClient(f.root, f.options).describeService()).toHaveProperty('instanceId');
  } finally { if (host) { await host.stop(); await host.settled; } clearConfigCache(); await rm(f.root, { recursive: true, force: true }); }
});

it.skipIf(process.platform !== 'linux')('publishes a scheduled checkpoint for later events and drains the monitor when the host stops', async () => {
  const f = await auditCheckpointFixture(); let host: Awaited<ReturnType<typeof startConfiguredRuntimeService>> | undefined;
  try {
    const configPath = join(f.root, '.deckent/config.json'), authored = JSON.parse(await readFile(configPath, 'utf8'));
    await writeFile(configPath, JSON.stringify({ ...authored, audit: { checkpointIntervalMs: 1000 }, cancellation: { maxConcurrentDeliveries: 1 },
      cancellationRuntime: { scopeIds: ['s'], pollIntervalMs: 1000, failureBackoffMs: 1000 }, toolchains: { update: { atStartup: false, intervalMs: 0 } } }));
    clearConfigCache(); const observed: AuditServiceStatus[] = [];
    host = await startConfiguredRuntimeService(f.root, { onPage() {}, onError() {}, onAuditIntegrity: status => { observed.push(status); } }, f.options);
    expect(host.auditIntegrity.status).toBe('ready');
    const config = await loadComposedConfig(f.root, f.options), integrity = await openLocalIntegrityAuthority(config.productLayout, config.approvals.keyFile);
    const store = await openSqliteAuditStore(productResourcePath(config.productLayout, 'ledger'), config.storage.sqlite);
    try { new AuditApplication(store, integrity).record({ schemaVersion: 1, eventId: 'later', scopeId: 's',
      principal: { issuer: 'test', subject: 'test' }, policyRevision: 'p', atMs: Date.now(), subject: { kind: 'full-access-turn', turnId: 'later-turn',
        sessionId: null, decision: { effect: 'allow', ruleId: 'test' } } }); }
    finally { store.close(); }
    await vi.waitFor(() => expect(observed.at(-1)?.verifications[0]?.head?.sequence).toBe(2), { timeout: 5000 });
    expect((await host.stop()).state).toBe('clean'); await host.settled;
    const reports = observed.length; await new Promise(resolve => setTimeout(resolve, 1100)); expect(observed).toHaveLength(reports);
  } finally { if (host) { await host.stop(); await host.settled; } clearConfigCache(); await rm(f.root, { recursive: true, force: true }); }
});
