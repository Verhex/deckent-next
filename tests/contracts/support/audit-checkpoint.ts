import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { openConfiguredAttemptStore } from '#composition/core/storage/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { AuditApplication } from '#engine/index.js';
import { FileInstallationIdentityStore, openLocalIntegrityAuthority, openSqliteAuditStore } from '#adapters/index.js';
import { productResourcePath } from '#platform/index.js';
export async function auditCheckpointFixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-audit-surfaces-'));
  const home = join(root, 'home'), data = join(root, 'data'); await mkdir(home); await mkdir(join(root, '.deckent'));
  await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, terminal: { scopeId: 's' } }));
  const options = { env: { HOME: home, USERPROFILE: home, DECKENT_GLOBAL_HOME: join(home, '.deckent') } };
  const owner = { issuer: hostname(), subject: String(userInfo().uid) }, mcp = { ...owner, issuer: `${hostname()}/mcp` };
  const config = await loadComposedConfig(root, options), opened = await openConfiguredAttemptStore(root, options); opened.store.close();
  const policyPath = productResourcePath(config.productLayout, 'policy');
  const document = { schemaVersion: 1, revision: 'p', restrictions: [], grants: [
    { id: 'inspect-audit', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals: [owner, mcp], resource: { kind: 'approval', ids: 'all' } },
    { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals: [owner, mcp], resource: { kind: 'scope', ids: ['s'] } },
  ] };
  await writeFile(policyPath, JSON.stringify(document), { mode: 0o600 });
  const identityStore = new FileInstallationIdentityStore(config.productLayout, config.configFile.writeLockTimeoutMs, undefined, config.installation);
  const identity = await identityStore.loadOrCreate();
  const integrity = await openLocalIntegrityAuthority(config.productLayout, config.approvals.keyFile, true), store = await openSqliteAuditStore(opened.path, config.storage.sqlite);
  try { new AuditApplication(store, integrity).record({ schemaVersion: 1, eventId: 'event', scopeId: 's', principal: owner,
    policyRevision: 'p', atMs: 10, subject: { kind: 'full-access-turn', turnId: 'turn', sessionId: null, decision: { effect: 'allow', ruleId: 'inspect-audit' } } }); }
  finally { store.close(); }
  return { root, data, options, policyPath, document, installationId: identity.installationId };
}

