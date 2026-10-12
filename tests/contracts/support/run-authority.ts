import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SqliteAuditStore, SqliteApprovalStore } from '#adapters/index.js';
import { AuditApplication, AuthorityDecisionRecords, RunCreateApprovalBroker, RunCreationAuthority, type PolicySource } from '#engine/index.js';
import { createHmacIntegrity, type TrustedClock } from '#platform/index.js';
/** Real shared ledger and MAC custody; test authority does not bypass admission or weaken any negative path. */
export function fixtureRunAuthority(path: string, source: PolicySource, now: () => number = () => 10) {
  const db = new DatabaseSync(path), integrity = createHmacIntegrity('test-run-key', randomBytes(32));
  const clock: TrustedClock = { sample: () => ({ wallMs: now(), monotonicMs: now() }) };
  const approvals = new SqliteApprovalStore(db), audit = new AuditApplication(new SqliteAuditStore(db), integrity);
  const authority = new RunCreationAuthority(source, new AuthorityDecisionRecords(audit),
    new RunCreateApprovalBroker(approvals, integrity, clock, { requestTtlMs: 1000, admitWithinMs: 1000 }), clock);
  return { db, integrity, clock, approvals, audit, authority, close: () => db.close() };
}
