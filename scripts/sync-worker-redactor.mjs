import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const producerPath = new URL('src/platform/core/redaction/internal/redact.ts', root);
const tablePath = new URL('src/platform/core/redaction/internal/patterns.json', root);
const workerPath = new URL('src/adapters/core/native-connection/internal/worker.ts', root);
const begin = '// B7 GENERATED REDACTOR BEGIN';
const end = '// B7 GENERATED REDACTOR END';
export function workerRedactorBlock(producer, table) {
  const body = producer.replace(/^import REDACTION_TABLE[^\n]*\n/, () => `const REDACTION_TABLE = ${JSON.stringify(JSON.parse(table))};\n`);
  const digest = createHash('sha256').update(producer).update('\0').update(table).digest('hex');
  return `${begin}\n// Canonical source+table sha256: ${digest}; scripts/sync-worker-redactor.mjs --check\n${body}${end}`;
}
export function syncWorkerRedactor(check = true) {
  const block = workerRedactorBlock(readFileSync(producerPath, 'utf8'), readFileSync(tablePath, 'utf8'));
  const worker = readFileSync(workerPath, 'utf8'), from = worker.indexOf(begin), to = worker.indexOf(end);
  if (from < 0 || to < from || worker.indexOf(begin, from + begin.length) >= 0) throw new Error('WORKER_REDACTOR_MARKERS_INVALID');
  const expected = worker.slice(0, from) + block + worker.slice(to + end.length);
  if (check && expected !== worker) throw new Error('WORKER_REDACTOR_DRIFT');
  if (!check) writeFileSync(workerPath, expected);
  return { ok: true, source: fileURLToPath(producerPath) };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args[0] !== '--check' && args[0] !== '--write')) throw new Error('WORKER_REDACTOR_USAGE');
  process.stdout.write(JSON.stringify(syncWorkerRedactor(args[0] !== '--write')) + '\n');
}
