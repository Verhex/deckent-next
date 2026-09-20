import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { openSqliteProviderSpendAuditStore } = await import(
  pathToFileURL(resolve('dist/adapters/core/sqlite-model-invocation/index.js')).href);
const receipt = JSON.parse(Buffer.from(process.argv[3], 'base64url').toString('utf8'));
const store = await openSqliteProviderSpendAuditStore(process.argv[2],
  { journalMode: 'delete', durability: 'full', busyTimeoutMs: 5_000 }, 'forbid');

function send(message) {
  return new Promise((accept, reject) => process.send(message, error => error ? reject(error) : accept()));
}

await send({ kind: 'ready' });
process.once('message', async message => {
  if (!message || message.kind !== 'go') process.exitCode = 2;
  else {
    try { await send({ kind: 'result', ok: true, result: await store.record(receipt) }); }
    catch (error) { await send({ kind: 'result', ok: false, code: error?.code ?? 'UNKNOWN' }); }
  }
  store.close(); process.disconnect();
});
