import { access, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [{ openSqliteModelInvocationStore }] = await Promise.all([
  import(pathToFileURL(resolve('dist/adapters/core/sqlite-model-invocation/index.js')).href),
]);
const operation = JSON.parse(Buffer.from(process.argv[3], 'base64url').toString('utf8'));
const ready = process.argv[4], gate = process.argv[5];
await writeFile(ready, 'ready');
const deadline = Date.now() + 5_000;
while (Date.now() < deadline) {
  try { await access(gate); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
}
if (Date.now() >= deadline) throw new Error('BARRIER_TIMEOUT');
const store = await openSqliteModelInvocationStore(process.argv[2],
  { journalMode: 'delete', durability: 'full', busyTimeoutMs: 5_000 }, 'forbid');
try {
  const result = operation.kind === 'permit'
    ? await store.permitSend(operation.claim, operation.ownerId, operation.now)
    : await store.cancelInvocation(operation.input);
  process.stdout.write(`${JSON.stringify(operation.kind === 'permit'
    ? { ok: true, granted: result.granted } : { ok: true, disposition: result.receipt.disposition })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, code: error?.code ?? 'UNKNOWN' })}\n`);
} finally { store.close(); }
