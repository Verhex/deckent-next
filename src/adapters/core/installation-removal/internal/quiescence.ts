import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { requireLedgerVersion, EFFECT_PRODUCER_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { ErrorRegistry } from '#platform/index.js';
import { targetQueueRecordSchema } from '#domain/index.js';
import type { UninstallWork } from '#engine/index.js';
/** node:sqlite loads only when the ledger is observed, so importing the SDK never loads it (sqlite-ledger-lazy). */
const nativeSqlite = () => createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
/** Read only and without new sidecars: a ledger with no live WAL opens immutable (measured: a plain read-only open leaves -wal/-shm behind). */
const openReadOnly = (path: string, busyTimeoutMs: number) => new (nativeSqlite().DatabaseSync)(existsSync(`${path}-wal`) || existsSync(`${path}-shm`) ? path
  : new URL(`${pathToFileURL(path).href}?immutable=1`), { readOnly: true, timeout: busyTimeoutMs });
const RUNNING = `SELECT scope_id s,run_id i,revision v FROM runs r WHERE CASE WHEN json_valid(snapshot) THEN json_extract(snapshot,'$.state.kind')='running' ELSE 1 END
  OR EXISTS(SELECT 1 FROM dispatches d WHERE d.scope_id=r.scope_id AND json_valid(d.record) AND json_extract(d.record,'$.request.identity.runId')=r.run_id
  AND json_extract(d.record,'$.terminal') IS NULL)`;
const UNKNOWN: UninstallWork = { running: [], parked: [], approvals: [], deliveries: [], uncertain: [], complete: false };
/** Whole-installation itemized work: revoked scope grants never hide unresolved business effects or active work. Each category is bounded;
 * one past the bound makes the observation incomplete (never zero). Settled history is never read as activity, however long it is. */
export function observeUninstallWork(path: string, limits: { readonly busyTimeoutMs: number; readonly maxRecords: number; readonly companyId?: string }): UninstallWork {
  if (!existsSync(path)) return { ...UNKNOWN, complete: true };
  let db; try { db = openReadOnly(path, limits.busyTimeoutMs); } catch { return UNKNOWN; }
  try { requireLedgerVersion(db, EFFECT_PRODUCER_LEDGER_VERSION); let complete = true;
    const rows = (sql: string) => { const found = db.prepare(`${sql} ORDER BY 1,2 LIMIT ?`).all(limits.maxRecords + 1); if (found.length > limits.maxRecords) complete = false;
      return found.slice(0, limits.maxRecords).map(row => ({ scopeId: String(row['s']), id: String(row['i']), target: row['t'] == null ? null : String(row['t']), revision: Number(row['v'] ?? 0) })); };
    const refs = (sql: string) => rows(sql).map(({ scopeId, id, revision }) => ({ scopeId, id, revision })); if (db.prepare('SELECT 1 FROM dispatches WHERE json_valid(record)=0 LIMIT 1').get()) complete = false;
    const uncertain = (kind: 'effect' | 'invocation' | 'reservation', sql: string) => rows(sql).map(({ scopeId, id, target }) => ({ kind, scopeId, id, target })); return { running: refs(RUNNING), parked: refs(`SELECT scope_id s,run_id i,revision v FROM runs WHERE json_valid(snapshot) AND json_extract(snapshot,'$.state.kind')='parked'`),
      approvals: refs(`SELECT scope_id s,approval_id i,revision v FROM approvals WHERE current=1 AND CASE WHEN json_valid(snapshot) THEN json_extract(snapshot,'$.status')='pending' ELSE 1 END`),
      deliveries: rows(`SELECT scope_id s,command_id i,revision v FROM target_queue WHERE state NOT IN ('settled','cancelled','expired')`).map(ref => {
        const record = targetQueueRecordSchema.parse(JSON.parse(String(db.prepare('SELECT record FROM target_queue WHERE scope_id=? AND command_id=?').get(ref.scopeId, ref.id)?.['record'])));
        if (record.request.identity.scopeId !== ref.scopeId || record.request.commandId !== ref.id || record.revision !== ref.revision) throw new Error('QUEUE_CORRUPT');
        const pin = db.prepare('SELECT company_id FROM scope_registry WHERE scope_id=?').get(ref.scopeId)?.['company_id'];
        return { scopeId: ref.scopeId, id: ref.id, revision: ref.revision, identity: record.request.identity, state: record.state,
          ...(limits.companyId ? { company: pin == null ? 'unregistered' as const : pin === limits.companyId ? 'current' as const : 'foreign' as const } : {}) }; }),
      uncertain: [...uncertain('effect', `SELECT scope_id s,command_id i,target_kind||'/'||target_id t FROM effect_intents WHERE state NOT IN ('settled','refused')`),
        ...uncertain('invocation', `SELECT scope_id s,invocation_id i,NULL t FROM model_invocations WHERE state IN ('claimed','unknown')`),
        ...uncertain('reservation', `SELECT scope_id s,invocation_id i,NULL t FROM model_invocation_spend_reservations WHERE CASE WHEN json_valid(record)=0 THEN 1
          ELSE json_extract(record,'$.disposition.state')='held' AND json_extract(record,'$.reconciliation') IS NULL END`)], complete };
  } catch { return UNKNOWN; } finally { db.close(); }
}
/** F7: one attempt's Run snapshot and its Run's delivery tickets (bounded), read only, for the workspace owner's idle decision; an unreadable one throws. */
export function attemptRecords(path: string, limits: { readonly busyTimeoutMs: number; readonly maxRecords: number }, identity: { readonly scopeId: string; readonly runId: string }) {
  const db = openReadOnly(path, limits.busyTimeoutMs), json = (row: Record<string, unknown> | undefined) => row ? JSON.parse(String(Object.values(row)[0])) as unknown : null;
  try { requireLedgerVersion(db, EFFECT_PRODUCER_LEDGER_VERSION); return { run: json(db.prepare('SELECT snapshot FROM runs WHERE scope_id=? AND run_id=?').get(identity.scopeId, identity.runId)),
    deliveries: db.prepare(`SELECT record FROM target_queue WHERE scope_id=? AND json_extract(record,'$.request.identity.runId')=? LIMIT ?`).all(identity.scopeId, identity.runId, limits.maxRecords).map(json) }; } finally { db.close(); }
}
/** Under lifecycle custody: every scope the ledger recorded data for joins the policy-named ones; the union is what the lifecycle decision
 * covers. An unreadable or unbounded scope record keeps the installation (typed refusal). Work itself is compared by the plan (D2). */
export function installationScopes(path: string, limits: { readonly busyTimeoutMs: number; readonly maxScopes: number }, scopeIds: readonly string[]): readonly string[] {
  let recorded: string[] | null = existsSync(path) ? null : []; // no ledger records no scope (a fresh installation)
  if (!recorded) try { const db = openReadOnly(path, limits.busyTimeoutMs); try { recorded = db.prepare('SELECT scope_id FROM scope_registry ORDER BY scope_id LIMIT ?').all(limits.maxScopes + 1).map(row => String(row['scope_id'])); } finally { db.close(); } }
  catch { /* unreadable: refused below */ }
  if (!recorded || recorded.length > limits.maxScopes) throw ErrorRegistry.createError('UNINSTALL_SCOPE_UNVERIFIED', { params: { path } });
  return Object.freeze([...new Set([...scopeIds, ...recorded])]);
}
