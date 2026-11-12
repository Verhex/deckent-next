import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
/** The worker bootstrap runs without host imports; its quota rule must be the exact pure host rule. */
export function syncWorkerQuota(check = true) {
  const source = readFileSync(new URL('src/capabilities/core/native-agent-execution/internal/quota-rule.ts', root), 'utf8');
  const path = new URL('src/adapters/core/native-connection/internal/worker.ts', root), worker = readFileSync(path, 'utf8');
  const begin = '// B2 GENERATED QUOTA BEGIN', end = '// B2 GENERATED QUOTA END';
  const from = worker.indexOf(begin), to = worker.indexOf(end);
  if (from < 0 || to < from || worker.indexOf(begin, from + begin.length) >= 0) throw new Error('WORKER_QUOTA_MARKERS_INVALID');
  const expected = worker.slice(0, from) + `${begin}\n// Canonical: capabilities/native-agent-execution/internal/quota-rule.ts; scripts/sync-worker-quota.mjs --check\n${source}${end}` + worker.slice(to + end.length);
  if (check && expected !== worker) throw new Error('WORKER_QUOTA_DRIFT');
  if (!check) writeFileSync(path, expected);
  return { ok: true };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || !['--check', '--write'].includes(args[0])) throw new Error('WORKER_QUOTA_USAGE');
  process.stdout.write(JSON.stringify(syncWorkerQuota(args[0] !== '--write')) + '\n');
}
