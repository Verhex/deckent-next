import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const [{ openSqliteModelInvocationStore }] = await Promise.all([
  import(pathToFileURL(resolve('dist/adapters/core/sqlite-model-invocation/index.js')).href),
]);
const admission = JSON.parse(Buffer.from(process.argv[3], 'base64url').toString('utf8'));
const store = await openSqliteModelInvocationStore(process.argv[2],
  { journalMode: 'delete', durability: 'full', busyTimeoutMs: 5_000 }, 'forbid');
try {
  const result = await store.claim(admission);
  process.stdout.write(`${JSON.stringify({ ok: true, replayed: result.replayed, invocationId: result.record.receipt.claim.invocationId })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, code: error?.code ?? 'UNKNOWN' })}\n`);
} finally { store.close(); }
