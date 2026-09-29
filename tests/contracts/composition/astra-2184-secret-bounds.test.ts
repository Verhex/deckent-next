import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createConnection } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { clearConfigCache, productResourcePath, resolveGlobalConfigPaths, resolveProductLayout } from '#platform/index.js';
import { createFileSecretStore, encodeServiceFrame, registerProviderConfig } from '#adapters/index.js';
import { applyPolicyTemplateInstallation } from '#composition/core/installation/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { createConfiguredRuntimeClient, startConfiguredRuntimeService } from '#composition/core/runtime-service/index.js';

// SECRET-WRITE (owner 2026-09-29, SECRET-K1 §5 option A + S3 = service socket): a secret change goes through the runtime service; the socket
// peer is the principal; the `secret`/`set|delete` policy cell decides it; every decision is a sealed `secret-change` audit event in the
// installation's ledger before any write; the value never reaches the ledger, an error or the service's output. Synthetic canaries only.
registerProviderConfig(); // as every composed entry does before configuration is loaded (the `secrets` section is registered there)
const CANARY = 'synthetic-canary-5c7a1e-not-a-real-key';
const roots: string[] = [];
const services: Awaited<ReturnType<typeof startConfiguredRuntimeService>>[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) { await service.stop().catch(() => undefined); await service.done.catch(() => undefined); }
  clearConfigCache();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(input: { readonly backend?: 'file' | 'env' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-secret-write-')); roots.push(root);
  const project = join(root, 'project'), home = join(root, 'home');
  await mkdir(project, { recursive: true }); await mkdir(home, { mode: 0o700 });
  const env: Record<string, string> = { HOME: home, PATH: process.env['PATH'] ?? '/usr/bin:/bin' };
  // A fresh installation: `deckent init policy` (first-run template v2) is the only authority document.
  await applyPolicyTemplateInstallation(project, 'installation');
  // The service's own bounded limits (as every service fixture); the layout stays the default one under the project.
  await writeFile(join(project, '.deckent', 'config.json'), JSON.stringify({
    cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 10, claimTtlMs: 100 },
    cancellationRuntime: { scopeIds: ['installation'], pollIntervalMs: 1000, failureBackoffMs: 1000 },
    service: { inputMaxBytes: 262144, responseMaxBytes: 65536, maxConnections: 8, maxConcurrentRequests: 8, maxConcurrentExecutions: 2,
      headerTimeoutMs: 1000, responseTimeoutMs: 10000, shutdownGraceMs: 50 } }), { mode: 0o600 });
  const globalPath = resolveGlobalConfigPaths(env).platformPath, globalRoot = dirname(globalPath);
  await mkdir(globalRoot, { recursive: true, mode: 0o700 }); await chmod(globalRoot, 0o700);
  if ((input.backend ?? 'file') === 'file') await writeFile(globalPath, JSON.stringify({ secrets: { store: 'core.secret-store.file@1' } }), { mode: 0o600 });
  // The ledger as every service fixture creates it (the service upgrades, it does not create one).
  (await openConfiguredAttemptStore(project, { env })).store.close(); clearConfigCache();
  const layout = resolveProductLayout({ projectRoot: project });
  const policyPath = productResourcePath(layout, 'policy'), ledger = productResourcePath(layout, 'ledger');
  const output: string[] = [];
  const service = await startConfiguredRuntimeService(project, { async onPage(...args: unknown[]) { output.push(JSON.stringify(args)); },
    async onError(...args: unknown[]) { output.push(JSON.stringify(args)); } }, { env });
  services.push(service);
  const client = createConfiguredRuntimeClient(project, { env });
  const file = createFileSecretStore({ root: globalRoot, platform: 'linux' });
  const audit = () => {
    const db = new DatabaseSync(ledger, { readOnly: true });
    try {
      return db.prepare('SELECT record FROM audit_events ORDER BY sequence').all().map(row => (JSON.parse(String(row['record'])) as
        { event: { scopeId: string; principal: unknown; policyRevision: string; subject: Record<string, unknown> } }).event);
    } finally { db.close(); }
  };
  const replacePolicy = async (grants: readonly unknown[]) => {
    const policy = JSON.parse(await readFile(policyPath, 'utf8')) as { grants: { id: string }[] };
    await writeFile(policyPath, JSON.stringify({ ...policy, revision: `edited-${grants.length}`,
      grants: [...policy.grants.filter(grant => grant.id !== 'first-run-secret-store' && !grant.id.startsWith('secret-')), ...grants] }), { mode: 0o600 });
  };
  /** Every byte the installation and the service left behind: ledger files, the policy/bindings documents and the service's output. */
  const scanForCanary = async () => {
    const hits: string[] = [];
    for (const name of await readdir(dirname(ledger))) {
      if (!name.startsWith(ledger.split('/').at(-1)!)) continue;
      if ((await readFile(join(dirname(ledger), name))).includes(Buffer.from(CANARY))) hits.push(name);
    }
    if (JSON.stringify(audit()).includes(CANARY)) hits.push('audit-view');
    if (output.join('\n').includes(CANARY)) hits.push('service-output');
    return hits;
  };
  return { project, home, env, globalRoot, client, file, audit, replacePolicy, scanForCanary, output, endpoint: service.endpoint };
}
const changes = (events: readonly { subject: Record<string, unknown> }[]) => events.filter(event => event.subject['kind'] === 'secret-change').map(event => event.subject);

it.skipIf(process.platform !== 'linux')('Astra: individually valid secret sets cannot make the whole store unreadable', async () => {
 const f=await fixture();
 await f.client.setSecret({schemaVersion:1,scopeId:'installation',name:'KEEP_ME',value:CANARY});
 const statuses=[]; let beforeLast:unknown=null;
 for(let i=0;i<16;i++) {
  if(i===15) beforeLast={bytes:(await stat(join(f.globalRoot,'secrets.json'))).size,readable:await f.file.get('KEEP_ME')===CANARY};
  const name=`LOAD_${i}`;
  const result=await f.client.setSecret({schemaVersion:1,scopeId:'installation',name,value:'x'.repeat(65536)}).then(()=>({ok:true}), (e:unknown)=>({ok:false,code:(e as {code?:string}).code}));
  statuses.push(result);
  if(!result.ok)break;
 }
 const bytes=(await stat(join(f.globalRoot,'secrets.json'))).size;
 const lookup=await f.file.get('KEEP_ME').then(value=>({readable:true,same:value===CANARY}), (e:unknown)=>({readable:false,code:(e as {code?:string}).code}));
 const cleanupResult=await f.client.deleteSecret({schemaVersion:1,scopeId:'installation',name:'LOAD_15'}).then(()=>({ok:true}), (e:unknown)=>({ok:false,code:(e as {code?:string}).code}));
 console.log('ASTRA_STORE_CAP',JSON.stringify({beforeLast,statuses,bytes,lookup,cleanupResult}));
 expect(beforeLast).toMatchObject({readable:true});
 expect(lookup).toEqual({readable:true,same:true});
},60000);

it.skipIf(process.platform !== 'linux')('Astra: impossible secret result capacity is refused before mutation', async () => {
 const f=await fixture();
 const raw=createConnection(f.endpoint);raw.on('error',()=>undefined);
 await new Promise<void>((resolve,reject)=>{raw.once('connect',resolve);raw.once('error',reject);});
 const chunks:Buffer[]=[];raw.on('data',b=>chunks.push(b as Buffer));
 const closed=new Promise<void>(resolve=>raw.once('close',()=>resolve()));
 raw.end(encodeServiceFrame({schemaVersion:18,requestId:'small-reply',operation:'setSecret',delivery:{maxResultBytes:1},input:{schemaVersion:1,scopeId:'installation',name:'REPLY_LIMIT',value:CANARY}},262144));
 await closed;
 const stored=await f.file.get('REPLY_LIMIT');
 const wire=Buffer.concat(chunks);
 console.log('ASTRA_REPLY_CAP',JSON.stringify({stored:stored===CANARY,response:wire.toString('utf8'),audits:changes(f.audit()).length}));
 expect(stored).toBeUndefined();
},60000);
