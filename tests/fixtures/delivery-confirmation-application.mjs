import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalOsSessionAuthority, GitIntegrationTarget, GitIntegrationDelivery, GitIntegrationAdoption, withMcpPrincipal } from '../../dist/adapters/index.js';
import { WorkspaceDeliveryApplication, WorkspaceAdoptionApplication } from '../../dist/engine/index.js';
import { SystemTrustedClock, snapshotKnownSecrets, ErrorRegistry } from '../../dist/platform/index.js';
import { verifiedDeliveryConfirmation } from '../../dist/composition/core/workspace-patch/index.js';
import { askDeliveryConfirmation } from '../../dist/surfaces/core/effect-confirmation/index.js';
const [root, mode] = process.argv.slice(2);
const data = JSON.parse(await readFile(join(root, 'input.json'), 'utf8'));
const clock = new SystemTrustedClock(() => data.time), sessions = await LocalOsSessionAuthority.create(['s'], 60000, clock);
const load = async name => { try { return JSON.parse(await readFile(join(root, name), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const save = async (name, record) => { await writeFile(join(root, name), JSON.stringify(record)); return record; };
const store = {
  async loadRun() { return data.run; }, async loadRunWorkspaceCustody() { return null; },
  async loadDelivery() { return load('delivery.json'); }, async findDelivery() { return load('delivery.json'); },
  async claimDelivery(intent) { return save('delivery.json', { intent, delivered: false }); },
  async finishDelivery(intent) { return save('delivery.json', { intent, delivered: true }); },
  async loadAdoption() { return load('adoption.json'); },
  async claimAdoption(intent) { return save('adoption.json', { intent, sequence: 1, settled: false }); },
  async finishAdoption(intent) { return save('adoption.json', { intent, sequence: 1, settled: true }); },
};
let revoked = false;
const authorization = { async authorizeIdentity(action, identity) { if (revoked) throw ErrorRegistry.createError('POLICY_DENIED'); if (!['deliver-integration', 'adopt-integration'].includes(action) || JSON.stringify(identity) !== JSON.stringify(data.patch.identity)) throw Error('unexpected authority'); } };
const patches = { async preview() { return { patch: data.patch, receipt: data.receipt, scope: { status: 'unscoped' } }; }, assertScope() {} };
const inspection = { async inspect() { return { manifest: data.manifest, receipt: data.receipt }; } };
const target = new GitIntegrationTarget(data.options, data.limits), delivery = new GitIntegrationDelivery(data.options);
const witness = verifiedDeliveryConfirmation(async view => {
  const stats = await new GitIntegrationDelivery(view.operation === 'deliver-integration' ? { ...data.options, sourceRoot: data.manifest.workspace } : data.options).describe(view.from, view.to);
  const answer = await askDeliveryConfirmation({ ...view, ...stats }, data.locale ?? 'en', process.stdin, process.stderr, { timeoutMs: mode === 'timeout' ? 150 : 60000 });
  if (mode === 'deliver-revoke' || mode === 'adopt-revoke') revoked = true;
  return answer;
});
const port = mode.includes('sdk') ? undefined : witness;
const app = new WorkspaceDeliveryApplication(patches, inspection, target, delivery, store, sessions, authorization, clock, port, snapshotKnownSecrets([{ name: 'FIXTURE_PRIVATE', value: 'fixture-private-title-secret' }]));
const adopt = new WorkspaceAdoptionApplication(store, delivery, new GitIntegrationAdoption(data.options), [data.target], sessions, authorization, clock,
  { requirement: null, registry: null, criterionWithin: () => false, async authorizeRun() {}, source: {} }, port, snapshotKnownSecrets([{ name: 'FIXTURE_PRIVATE', value: 'fixture-private-title-secret' }]));
try {
  const work = () => mode.startsWith('adopt') ? adopt.adopt({ schemaVersion: 2, commandId: 'adopt', identity: data.patch.identity, deliveryCommandId: 'delivery', targetRef: data.target }) : app.deliver(data.command);
  const result = mode.includes('mcp') ? await withMcpPrincipal(work) : await work();
  process.stderr.write('\n' + JSON.stringify({ response: { ok: true, result } }) + '\n');
} catch (error) {
  process.stderr.write('\n' + JSON.stringify({ response: { ok: false, error: { code: error.code ?? 'fixture-failed', message: error.message } } }) + '\n');
}
