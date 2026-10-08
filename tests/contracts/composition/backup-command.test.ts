import { Worker } from 'node:worker_threads';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { executeBackup, clearConfigCache, loadConfig, resolveProductLayout, productResourcePath, startConfiguredRuntimeService } from '../../../src/index.js';
import { FileInstallationIdentityStore } from '#adapters/core/installation-files/index.js';
import { openLocalIntegrityAuthority } from '#adapters/core/local-keyring/index.js';
import { openSqliteLedger, CURRENT_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { readLocalOsIdentity } from '#adapters/core/local-principal/index.js';
import { firstRunPolicyTemplate } from '#domain/index.js';
import { main } from '#surfaces/core/cli/index.js';
import { verifyAuditRecord } from '#engine/index.js';
import { DOWNGRADE_TO_PREVIOUS_LEDGER_SQL } from '../../fixtures/ledger-previous.js';
import { composeCore } from '#composition/core/root/index.js';
import { openConfiguredArtifactStore } from '#composition/core/artifacts/index.js';
const roots: string[] = [], workers: Worker[] = [], services: Awaited<ReturnType<typeof startConfiguredRuntimeService>>[] = [];
const phrase = 'CANARY-backup-operator-secret-🐦';
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.terminate();
  for (const service of services.splice(0)) { await service.stop(); await service.done; }
  clearConfigCache(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'deckent-product-backup-')); roots.push(base);
  const root = join(base, 'project'), data = join(base, 'data'), env = { HOME: join(base, 'home'), DECKENT_GLOBAL_HOME: join(base, 'global'), NO_COLOR: '1' };
  const layout = resolveProductLayout({ projectRoot: root, root: data });
  for (const dir of [root, join(root, '.deckent'), data, join(data, 'state'), join(data, 'artifacts')]) await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = async (path: string, value: unknown) => { await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 }); };
  await file(join(root, '.deckent/config.json'), { layout: { root: data }, backup: { schedule: 'off' },
    cancellation: { maxConcurrentDeliveries: 1 }, cancellationRuntime: { scopeIds: ['scope'], pollIntervalMs: 1000, failureBackoffMs: 1000 },
    service: { identity: { scopeId: 'scope', serviceId: 'backup-host' } }, toolchains: { update: { atStartup: false, intervalMs: 0 } } });
  const identity = await new FileInstallationIdentityStore(layout, 2000).loadOrCreate();
  await openLocalIntegrityAuthority(layout, 'authority.key', true);
  const template = firstRunPolicyTemplate({ scopeId: 'scope', principal: readLocalOsIdentity(), readToolNames: ['read_file'], scratchToolNames: ['write_scratch'],
    scratchWriteOperationId: 'workspace.scratch.write', editShellToolNames: ['edit_file', 'run_shell'], writeOperationId: 'workspace.file.write', shellOperationId: 'shell.execute',
    proposeMcpToolName: 'propose_mcp_server', mcpCallOperationId: 'mcp.tool.call', policyAdministerOperationId: 'policy.administer' });
  await file(productResourcePath(layout, 'policy'), template.policy); await file(productResourcePath(layout, 'bindings'), template.bindings);
  await file(join(data, 'artifacts/result.txt'), 'retained artifact');
  const ledger = productResourcePath(layout, 'ledger');
  const db = openSqliteLedger(ledger, { busyTimeoutMs: 1000, journalMode: 'wal', durability: 'full' });
  db.exec('CREATE TABLE backup_load(id INTEGER PRIMARY KEY, value TEXT); CREATE TABLE backup_count(n INTEGER NOT NULL); INSERT INTO backup_count VALUES(0);');
  db.close(); await chmod(ledger, 0o600);
  return { base, root, layout, env, ledger, installationId: identity.installationId, set: join(base, 'set'), target: join(base, 'restored') };
}
async function call(f: Awaited<ReturnType<typeof fixture>>, action: 'create' | 'verify' | 'restore', passphrase = phrase, extra = {}) {
  return executeBackup(f.root, { schemaVersion: 1, scopeId: 'scope', action, set: f.set, ...(action === 'restore' ? { target: f.target } : {}), ...extra } as Parameters<typeof executeBackup>[1], passphrase, { env: f.env });
}
async function audit(f: Awaited<ReturnType<typeof fixture>>) {
  const dir = join(f.layout.root, 'audit/backup-operations');
  const integrity = await openLocalIntegrityAuthority(f.layout, 'authority.key');
  return Promise.all((await readdir(dir)).map(async name => verifyAuditRecord(JSON.parse(await readFile(join(dir, name), 'utf8')), integrity)));
}
it('CLI → application → online WAL backup under concurrent writes → verify → restore preserves a consistent ledger, artifacts, key and relocation', async () => {
  const f = await fixture();
  const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads'); const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(workerData, { timeout: 1000 }); db.exec('PRAGMA journal_mode=WAL');
    let count = 0; function batch() { db.exec('BEGIN IMMEDIATE'); for (let i=0;i<100;i++) db.prepare('INSERT INTO backup_load(value) VALUES(?)').run('value-'+(++count));
      db.prepare('UPDATE backup_count SET n=?').run(count); db.exec('COMMIT'); if(count===100) parentPort.postMessage('ready'); setTimeout(batch,1); } batch();`, { eval: true, workerData: f.ledger }); workers.push(worker);
  await new Promise<void>((resolve, reject) => { worker.once('message', () => resolve()); worker.once('error', reject); });
  let output = '', errors = '';
  expect(await main(['backup', 'create', '--scope', 'scope', '--set', f.set, '--json'], { root: f.root, env: f.env, initialize: composeCore,
    executeBackup, stdin: Readable.from([phrase + '\n']), stdout: { write: text => { output += text; } }, stderr: { write: text => { errors += text; } } })).toBe(0);
  expect(errors).toBe(''); expect(JSON.parse(output).action).toBe('create'); expect(output).not.toContain(phrase);
  await call(f, 'verify');
  const frozen = new DatabaseSync(join(f.set, 'ledger.db'), { readOnly: true });
  const count = Number(frozen.prepare('SELECT n FROM backup_count').get()?.n);
  expect(count).toBeGreaterThanOrEqual(100); expect(frozen.prepare('SELECT count(*) AS n FROM backup_load').get()?.n).toBe(count); frozen.close();
  expect((await stat(f.ledger+'-wal')).size).toBeGreaterThan(0);
  await worker.terminate(); workers.splice(workers.indexOf(worker), 1);
  const result = await call(f, 'restore');
  expect(result.relocation?.required).toBe(true); expect(result.relocation?.changedPaths).toContain('/layout/root');
  const restored = resolveProductLayout({ projectRoot: f.target });
  expect(await readFile(join(restored.root, 'artifacts/result.txt'), 'utf8')).toBe('retained artifact');
  expect(await readFile(join(restored.root, 'approvals/authority.key'))).toEqual(await readFile(join(f.layout.root, 'approvals/authority.key')));
  const db = new DatabaseSync(productResourcePath(restored, 'ledger'), { readOnly: true });
  expect(db.prepare('SELECT n FROM backup_count').get()?.n).toBe(count); db.close();
  await expect(new FileInstallationIdentityStore(restored, 2000).read()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_RELOCATED' });
  await new FileInstallationIdentityStore(restored, 2000).resolveRelocation('keep', { issuer: readLocalOsIdentity().issuer, subject: readLocalOsIdentity().subject });
  expect((await new FileInstallationIdentityStore(restored, 2000).read())).toMatchObject({ value: { installationId: f.installationId } });
  for (const name of ['MANIFEST.sha256','ledger.db','ledger.fingerprint.json','state.archive.json.gz','authority.key.enc']) expect((await stat(join(f.set,name))).mode & 0o777).toBe(0o600);
  expect((await stat(f.set)).mode & 0o777).toBe(0o700);
  const integrity = await openLocalIntegrityAuthority(f.layout, 'authority.key');
  const recoveryAudit = join(f.base, '.deckent-backup-audit');
  const recoveryRecords = await Promise.all((await readdir(recoveryAudit)).map(async name => verifyAuditRecord(JSON.parse(await readFile(join(recoveryAudit, name), 'utf8')), integrity)));
  expect(recoveryRecords.map(record => record.event.subject.kind === 'backup-operation' ? record.event.subject.phase : null).sort()).toEqual(['intent','succeeded']);
  expect(JSON.stringify(recoveryRecords)).not.toContain(phrase);
  const records = await audit(f); expect(records.filter(record => record.event.subject.kind === 'backup-operation')).toHaveLength(4);
  expect(JSON.stringify(records)).not.toContain(phrase);
  const { gunzipSync } = await import('node:zlib');
  expect(gunzipSync(await readFile(join(f.set, 'state.archive.json.gz'))).toString()).not.toContain((await readFile(join(f.layout.root, 'approvals/authority.key'))).toString('base64'));
}, 30000);
it('tampered manifest and wrong passphrase refuse before any target state is published, and are audited without secrets', async () => {
  const f = await fixture(); await call(f,'create');
  await expect(call(f,'verify','CANARY-wrong-passphrase')).rejects.toMatchObject({code:'BACKUP_PASSPHRASE_INVALID'});
  const manifest = join(f.set,'MANIFEST.sha256'); await writeFile(manifest,(await readFile(manifest,'utf8')).replace(/^[0-9a-f]/,'x'));
  await expect(call(f,'restore')).rejects.toMatchObject({code:'BACKUP_MANIFEST_INVALID'});
  await expect(stat(f.target)).rejects.toMatchObject({code:'ENOENT'});
  const records=await audit(f);expect(records.some(record=>record.event.subject.kind==='backup-operation'&&record.event.subject.code==='BACKUP_PASSPHRASE_INVALID')).toBe(true);
  expect(JSON.stringify(records)).not.toContain('CANARY-wrong-passphrase');
});
it('refuses nonempty targets without exact confirmation, preserves damaged files on confirmed restore and requires installation-wide policy', async () => {
  const f=await fixture();await call(f,'create');
  await expect(call(f,'restore',phrase,{target:f.root})).rejects.toMatchObject({code:'BACKUP_TARGET_NOT_EMPTY'});
  await writeFile(join(f.layout.root,'artifacts/result.txt'),'damaged');
  const result=await call(f,'restore',phrase,{target:f.root,confirmTarget:f.root});
  expect(result.preserved.length).toBeGreaterThan(0);expect(await readFile(join(f.layout.root,'artifacts/result.txt'),'utf8')).toBe('retained artifact');
  const policyPath=productResourcePath(f.layout,'policy');const policy=JSON.parse(await readFile(policyPath,'utf8'));
  policy.grants.find((grant:{id:string})=>grant.id==='first-run-backup').scopes=['scope'];await writeFile(policyPath,JSON.stringify(policy));
  await expect(call(f,'verify')).rejects.toMatchObject({code:'BACKUP_POLICY_DENIED'});
});
it.skipIf(process.platform !== 'linux')('refuses restore while the actual runtime service owns the ledger, even at another configured endpoint', async () => {
  const f=await fixture();await call(f,'create');
  const path=join(f.root,'.deckent/config.json'),config=JSON.parse(await readFile(path,'utf8')); config.layout.resources={runtimeSocket:'state/alternate.sock'};await writeFile(path,JSON.stringify(config));clearConfigCache();
  const service=await startConfiguredRuntimeService(f.root,{async onPage(){},async onError(){}},{env:f.env});services.push(service);
  config.layout.resources = {}; await writeFile(path, JSON.stringify(config)); clearConfigCache();
  await expect(call(f,'restore',phrase,{target:f.root,confirmTarget:f.root})).rejects.toMatchObject({code:'BACKUP_SERVICE_RUNNING'});
  expect(await readFile(join(f.layout.root,'artifacts/result.txt'),'utf8')).toBe('retained artifact');
});
it('total-loss restore uses the authenticated retained policy and keeps the installation id',async()=>{
  const f=await fixture();await call(f,'create');
  await rm(f.root,{recursive:true,force:true});await rm(f.layout.root,{recursive:true,force:true});
  const lost=join(f.base,'lost');await mkdir(lost,{mode:0o700});
  const result=await executeBackup(lost,{schemaVersion:1,scopeId:'scope',action:'restore',set:f.set,target:lost},phrase,{env:f.env});
  expect(result.relocation?.required).toBe(true);
  const identity=JSON.parse(await readFile(join(lost,'.deckent/installation-identity/identity.json'),'utf8'));expect(identity.installationId).toBe(f.installationId);
});

it.skipIf(process.platform !== 'linux')('runtime serve exposes the actual daily backup event, audits it and shutdown awaits its work',async()=>{
  const f=await fixture(),path=join(f.root,'.deckent/config.json');const config=JSON.parse(await readFile(path,'utf8'));
  config.backup={schedule:'daily',retention:3};await writeFile(path,JSON.stringify(config));clearConfigCache();
  const controller=new AbortController();let output='',errors='';
  const timer=setTimeout(()=>controller.abort(),10000);
  try {
    expect(await main(['runtime','serve','--json'],{root:f.root,signal:controller.signal,env:{...f.env,BACKUP_PASSPHRASE:phrase},
      startRuntimeService:startConfiguredRuntimeService,stdout:{write(text){output+=text;if(text.includes('backup-schedule'))controller.abort();}},stderr:{write(text){errors+=text;}}})).toBe(0);
  } finally {clearTimeout(timer);}
  expect(output).toContain('backup-schedule');expect(output).toContain('created');expect(output+errors).not.toContain(phrase);
  const directory=join(f.layout.root,'state/backups/recovery');expect(await readdir(directory)).toHaveLength(1);
  expect((await audit(f)).some(record=>record.event.subject.kind==='backup-operation'&&record.event.subject.phase==='succeeded')).toBe(true);
  const sets=await readdir(directory);await executeBackup(f.root,{schemaVersion:1,scopeId:'scope',action:'verify',set:join(directory,sets[0]!)},phrase,{env:f.env});
});
it.skipIf(process.platform !== 'linux')('before-upgrade creates a complete set before migrating the ledger, and missing scheduling credentials prevent migration',async()=>{
  const f=await fixture(),path=join(f.root,'.deckent/config.json');const config=JSON.parse(await readFile(path,'utf8'));
  config.backup={schedule:'before-upgrade',retention:3};await writeFile(path,JSON.stringify(config));clearConfigCache();
  const db=new DatabaseSync(f.ledger);db.exec(DOWNGRADE_TO_PREVIOUS_LEDGER_SQL);db.close();
  await expect(startConfiguredRuntimeService(f.root,{async onPage(){},async onError(){}},{env:f.env})).rejects.toMatchObject({code:'BACKUP_SCHEDULE_SECRET_REQUIRED'});
  const unchanged=new DatabaseSync(f.ledger,{readOnly:true});expect(unchanged.prepare('PRAGMA user_version').get()?.user_version).toBe(CURRENT_LEDGER_VERSION-1);unchanged.close();
  const service=await startConfiguredRuntimeService(f.root,{async onPage(){},async onError(){}},{env:{...f.env,BACKUP_PASSPHRASE:phrase}});services.push(service);
  const directory=join(f.layout.root,'state/backups/recovery'),sets=await readdir(directory);expect(sets).toHaveLength(1);
  const snapshot=new DatabaseSync(join(directory,sets[0]!,'ledger.db'),{readOnly:true});expect(snapshot.prepare('PRAGMA user_version').get()?.user_version).toBe(CURRENT_LEDGER_VERSION-1);snapshot.close();
});
it('a rewritten payload plus a recomputed manifest still cannot bypass AEAD, and link targets are refused',async()=>{
  const f=await fixture();await call(f,'create');const {createHash}=await import('node:crypto');
  const {symlink}=await import('node:fs/promises');const link=join(f.base,'link');await symlink(f.root,link);
  await expect(call(f,'restore',phrase,{target:link,confirmTarget:link})).rejects.toMatchObject({code:'BACKUP_PATH_UNSAFE'});
  const path=join(f.set,'ledger.fingerprint.json');await writeFile(path,'forged');
  const manifest=join(f.set,'MANIFEST.sha256'),text=await readFile(manifest,'utf8');
  const digest=createHash('sha256').update('forged').digest('hex');await writeFile(manifest,text.replace(/^[a-f0-9]{64} {2}ledger.fingerprint.json$/m,digest+'  ledger.fingerprint.json'));
  await expect(call(f,'verify')).rejects.toMatchObject({code:'BACKUP_PASSPHRASE_INVALID'});

});

it('recovers damaged configuration and a lost key in place without inventing an installation identity',async()=>{
  const f=await fixture();await call(f,'create');await writeFile(join(f.root,'.deckent/config.json'),'{broken');
  await rm(join(f.layout.root,'approvals/authority.key'));clearConfigCache();
  const result=await call(f,'restore',phrase,{target:f.root,confirmTarget:f.root});
  expect(result.relocation?.required).toBe(false);
  const identity=await new FileInstallationIdentityStore(f.layout,2000).read();expect(identity).toMatchObject({value:{installationId:f.installationId}});
  expect(JSON.parse(await readFile(join(f.root,'.deckent/config.json'),'utf8')).layout.root).toBe(f.layout.root);
});
it('archives the global layer apart: a restore on the same machine keeps it in the global file, never in the project config (S1 D1)',async()=>{
  const f=await fixture();await mkdir(f.env.DECKENT_GLOBAL_HOME,{recursive:true,mode:0o700});
  await writeFile(join(f.env.DECKENT_GLOBAL_HOME,'config.json'),JSON.stringify({language:'tr'}),{mode:0o600});clearConfigCache();
  await call(f,'create');const result=await call(f,'restore');
  expect(JSON.parse(await readFile(join(f.target,'.deckent/config.json'),'utf8')).language).toBeUndefined();
  expect(result.globalConfig).toEqual({path:join(f.env.DECKENT_GLOBAL_HOME,'config.json'),added:[],kept:[]});
  expect((await loadConfig(f.target,{env:f.env})).language).toBe('tr');
});
const SELECTED_STORE='core.secret-store.encrypted-file@1';
async function selectStore(f: Awaited<ReturnType<typeof fixture>>) {
  await mkdir(f.env.DECKENT_GLOBAL_HOME,{recursive:true,mode:0o700});
  await writeFile(join(f.env.DECKENT_GLOBAL_HOME,'config.json'),JSON.stringify({language:'tr',secrets:{store:SELECTED_STORE}}),{mode:0o600});clearConfigCache();
}
it('store selected → backup → ledger and config lost → in-place restore → config admitted and the service starts, no manual step (S1 D1)',async()=>{
  const f=await fixture();await selectStore(f);await call(f,'create');
  await rm(f.ledger);await writeFile(join(f.root,'.deckent/config.json'),'{broken');clearConfigCache();
  const result=await call(f,'restore',phrase,{target:f.root,confirmTarget:f.root});
  expect(result.globalConfig).toMatchObject({added:[],kept:[]});
  const project=JSON.parse(await readFile(join(f.root,'.deckent/config.json'),'utf8'));expect(project.secrets).toBeUndefined();expect(project.language).toBeUndefined();
  clearConfigCache();const config=await loadConfig(f.root,{env:f.env});expect((config as unknown as Record<string, unknown>).secrets).toEqual({store:SELECTED_STORE});expect(config.language).toBe('tr');
  if(process.platform==='linux'){const service=await startConfiguredRuntimeService(f.root,{async onPage(){},async onError(){}},{env:f.env});await service.stop();await service.done;}
});
it('whole machine lost: the empty global home receives the archived global layer, the project config stays project-only (S1 D1)',async()=>{
  const f=await fixture();await selectStore(f);await call(f,'create');
  await rm(f.root,{recursive:true,force:true});await rm(f.layout.root,{recursive:true,force:true});await rm(f.env.DECKENT_GLOBAL_HOME,{recursive:true,force:true});clearConfigCache();
  const lost=join(f.base,'lost');await mkdir(lost,{mode:0o700});
  const result=await executeBackup(lost,{schemaVersion:1,scopeId:'scope',action:'restore',set:f.set,target:lost},phrase,{env:f.env});
  const globalPath=join(f.env.DECKENT_GLOBAL_HOME,'config.json');
  expect(result.globalConfig).toEqual({path:globalPath,added:['language','secrets'],kept:[]});
  expect(JSON.parse(await readFile(globalPath,'utf8'))).toMatchObject({language:'tr',secrets:{store:SELECTED_STORE}});
  expect((await stat(f.env.DECKENT_GLOBAL_HOME)).mode&0o777).toBe(0o700);expect((await stat(globalPath)).mode&0o777).toBe(0o600);
  expect(JSON.parse(await readFile(join(lost,'.deckent/config.json'),'utf8')).secrets).toBeUndefined();
  clearConfigCache();expect(((await loadConfig(lost,{env:f.env})) as unknown as Record<string, unknown>).secrets).toEqual({store:SELECTED_STORE});
});
/** Recovery envelope v1 as documented (scrypt N=65536,r=8,p=1 + AES-256-GCM, AAD = payload manifest lines), written independently here. */
async function sealKeyV1(material: Buffer, passphrase: string, aad: string) {
  const { createCipheriv, randomBytes, scrypt } = await import('node:crypto');
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = await new Promise<Buffer>((resolve, reject) => scrypt(passphrase, salt, 32, { N: 65536, r: 8, p: 1, maxmem: 100663296 }, (error, out) => error ? reject(error) : resolve(out)));
  const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(material), cipher.final()]);
  return JSON.stringify({ schemaVersion: 1, kdf: 'scrypt', cipher: 'aes-256-gcm', salt: salt.toString('hex'), iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), ciphertext: ciphertext.toString('hex') });
}
/** An alpha.18 (v1) set: one merged global+project config document. Produced from a v2 set and re-sealed with the set's own passphrase. */
async function downgradeToV1(f: Awaited<ReturnType<typeof fixture>>) {
  const { gunzipSync, gzipSync } = await import('node:zlib'); const { createHash } = await import('node:crypto');
  const archive = join(f.set, 'state.archive.json.gz'), state = JSON.parse(gunzipSync(await readFile(archive)).toString());
  const entry = state.entries.find((item: { resource: string; path: string }) => item.resource === 'config' && item.path === '');
  const global = state.globalConfig ? JSON.parse(Buffer.from(state.globalConfig, 'base64').toString()) : {};
  entry.content = Buffer.from(JSON.stringify({ ...global, ...JSON.parse(Buffer.from(entry.content, 'base64').toString()) })).toString('base64');
  state.schemaVersion = 1; delete state.globalConfig;
  await writeFile(archive, gzipSync(JSON.stringify(state)), { mode: 0o600 });
  const digest = async (name: string) => createHash('sha256').update(await readFile(join(f.set, name))).digest('hex');
  const payload = (await Promise.all(['ledger.db', 'ledger.fingerprint.json', 'state.archive.json.gz'].map(async name => `${await digest(name)}  ${name}\n`))).join('');
  await writeFile(join(f.set, 'authority.key.enc'), await sealKeyV1(await readFile(join(f.layout.root, 'approvals/authority.key')), phrase, payload), { mode: 0o600 });
  await writeFile(join(f.set, 'MANIFEST.sha256'), payload + `${await digest('authority.key.enc')}  authority.key.enc\n`, { mode: 0o600 });
}
it('an alpha.18 merged (v1) set restores without moving the secrets selection into the project layer (S1 D1)',async()=>{
  const f=await fixture();await selectStore(f);await call(f,'create');await downgradeToV1(f);await call(f,'verify');
  await rm(f.env.DECKENT_GLOBAL_HOME,{recursive:true,force:true});await writeFile(join(f.root,'.deckent/config.json'),'{broken');clearConfigCache();
  const result=await call(f,'restore',phrase,{target:f.root,confirmTarget:f.root});
  expect(result.globalConfig?.added).toEqual(['secrets']);
  const project=JSON.parse(await readFile(join(f.root,'.deckent/config.json'),'utf8'));
  expect(project.secrets).toBeUndefined();expect(project.language).toBe('tr');
  clearConfigCache();expect(((await loadConfig(f.root,{env:f.env})) as unknown as Record<string, unknown>).secrets).toEqual({store:SELECTED_STORE});
  if(process.platform==='linux'){const service=await startConfiguredRuntimeService(f.root,{async onPage(){},async onError(){}},{env:f.env});await service.stop();await service.done;}
});
it.skipIf(process.platform !== 'linux')('scheduled retention keeps the three newest authenticated sets and preserves foreign names',async()=>{
  const f=await fixture(),path=join(f.root,'.deckent/config.json'),config=JSON.parse(await readFile(path,'utf8'));
  config.backup={schedule:'before-upgrade',retention:3};await writeFile(path,JSON.stringify(config));clearConfigCache();
  const directory=join(f.layout.root,'state/backups/recovery');
  await mkdir(directory,{recursive:true,mode:0o700});await writeFile(join(directory,'operator-note'),'keep',{mode:0o600});
  for(let round=0;round<4;round++){
    const db=new DatabaseSync(f.ledger);db.exec(DOWNGRADE_TO_PREVIOUS_LEDGER_SQL);db.close();
    const service=await startConfiguredRuntimeService(f.root,{async onPage(){},async onError(){}},{env:{...f.env,BACKUP_PASSPHRASE:phrase}});
    services.push(service);await service.stop();await service.done;services.splice(services.indexOf(service),1);
  }
  expect((await readdir(directory)).filter(name=>name.startsWith('recovery-'))).toHaveLength(3);
  expect(await readFile(join(directory,'operator-note'),'utf8')).toBe('keep');
});

it('exact target confirmation does not grant authority to overwrite another installation',async()=>{
  const f=await fixture();await call(f,'create');const directory=join(f.target,'.deckent/installation-identity');
  await mkdir(directory,{recursive:true,mode:0o700});const path=join(directory,'identity.json');
  await writeFile(path,JSON.stringify({schemaVersion:1,installationId:'another-installation'}),{mode:0o600});
  await expect(call(f,'restore',phrase,{confirmTarget:f.target})).rejects.toMatchObject({code:'BACKUP_TARGET_IDENTITY_MISMATCH'});
  expect(JSON.parse(await readFile(path,'utf8')).installationId).toBe('another-installation');
});

it.skipIf(process.platform !== 'linux')('refuses a confirmed target whose existing service uses another external layout',async()=>{
  const f=await fixture(),other=await fixture();await call(f,'create');
  const path=join(other.root,'.deckent/config.json'),before=await readFile(path);
  const service=await startConfiguredRuntimeService(other.root,{async onPage(){},async onError(){}},{env:other.env});services.push(service);
  await expect(call(f,'restore',phrase,{target:other.root,confirmTarget:other.root})).rejects.toMatchObject({code:'BACKUP_PATH_UNSAFE'});
  expect(await readFile(path)).toEqual(before);
});

it('same-root restore after a layout move publishes into the layout its restored config names; the real artifact reader opens the content (Astra 2471 R2)',async()=>{
  const f=await fixture();const opened=await openConfiguredArtifactStore(f.root,{env:f.env});
  const receipt=await opened.store.put('scope',Buffer.from('retained by the reader'));await call(f,'create');
  const path=join(f.root,'.deckent/config.json'),config=JSON.parse(await readFile(path,'utf8'));
  config.layout.resources={artifacts:'artifacts-v2'};await writeFile(path,JSON.stringify(config));
  await rename(join(f.layout.root,'artifacts'),join(f.layout.root,'artifacts-v2'));await writeFile(join(f.layout.root,'artifacts-v2/result.txt'),'changed after backup');clearConfigCache();
  await call(f,'restore',phrase,{target:f.root,confirmTarget:f.root});
  expect(JSON.parse(await readFile(path,'utf8')).layout.resources.artifacts).toBe('artifacts-v2');clearConfigCache();
  const reopened=await openConfiguredArtifactStore(f.root,{env:f.env});expect(reopened.path).toBe(join(f.layout.root,'artifacts-v2'));
  expect(Buffer.from(await reopened.store.read('scope',receipt)).toString()).toBe('retained by the reader');
  expect(await readFile(join(reopened.path,'result.txt'),'utf8')).toBe('retained artifact');
  expect(await readdir(f.layout.root)).toContainEqual(expect.stringMatching(/^artifacts-v2\.damaged-/));
});
it('a damaged installation policy refuses restore with a typed code naming the file; moving it aside and rerunning restores the set policy (S1 D3)',async()=>{
  const f=await fixture();await call(f,'create');const policyPath=productResourcePath(f.layout,'policy'),before=await readFile(policyPath,'utf8');
  await writeFile(policyPath,'{corrupt');clearConfigCache();
  await expect(call(f,'restore',phrase,{target:f.root,confirmTarget:f.root})).rejects.toMatchObject({code:'BACKUP_POLICY_UNREADABLE',params:{path:policyPath,reason:'POLICY_FILE_INVALID'}});
  let errors='';
  expect(await main(['backup','restore','--scope','scope','--set',f.set,'--target',f.root,'--confirm-target',f.root,'--json','--lang','tr'],{root:f.root,env:f.env,initialize:composeCore,executeBackup,
    stdin:Readable.from([phrase+'\n']),stdout:{write:()=>{}},stderr:{write:text=>{errors+=text;}}})).not.toBe(0);
  expect(JSON.parse(errors)).toMatchObject({code:'BACKUP_POLICY_UNREADABLE'});expect(errors).toContain(`mv ${policyPath} ${policyPath}.damaged`);expect(errors).toContain('hiçbir şey değiştirilmedi');
  await rename(policyPath,`${policyPath}.damaged`);clearConfigCache();
  await call(f,'restore',phrase,{target:f.root,confirmTarget:f.root});
  expect(await readFile(policyPath,'utf8')).toBe(before);
});
