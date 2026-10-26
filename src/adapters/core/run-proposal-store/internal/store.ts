import type { DatabaseSync } from 'node:sqlite';
import { encodeCommandProjection, runSnapshotSchema } from '#domain/index.js';
import { parseRunProposalEnvelope, isRunIntent, proposalIdentity, recheckRunProposalBudget, classifyWorkSpending, proposalRunGraph, type RunProposalRecord, type RunProposalEnvelope, type RunCreate, type RunReceipt } from '#engine/index.js';
import { ErrorRegistry } from '#platform/index.js';
import { requireLedgerVersion, RUN_PROPOSAL_LEDGER_VERSION, RUN_INTENT_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
export function readRunProposal(db: DatabaseSync, scopeId: string, commandId: string): RunProposalEnvelope | null {
  requireLedgerVersion(db, RUN_PROPOSAL_LEDGER_VERSION);
  const row = db.prepare('SELECT proposal_id,run_id,revision,record FROM run_proposals WHERE scope_id=? AND command_id=?').get(scopeId, commandId);
  if (!row) return null;
  let record: RunProposalEnvelope;
  try { record = parseRunProposalEnvelope(JSON.parse(String(row.record))); } catch { throw ErrorRegistry.createError('RUN_PROPOSAL_CORRUPT'); }
  if (record.schemaVersion === 2) requireLedgerVersion(db, RUN_INTENT_LEDGER_VERSION);
  const identity = proposalIdentity(record);
  const receipt = db.prepare('SELECT record FROM run_proposal_receipts WHERE scope_id=? AND command_id=? AND revision=?').get(scopeId, commandId, record.revision);
  if (identity.scopeId !== scopeId || identity.commandId !== commandId || identity.proposalId !== row.proposal_id
    || identity.runId !== row.run_id || record.revision !== row.revision
    || receipt?.record !== row.record) throw ErrorRegistry.createError('RUN_PROPOSAL_CORRUPT');
  if (!isRunIntent(record) && record.status === 'accepted') {
    try {
      const admitted = db.prepare('SELECT snapshot FROM run_receipts WHERE scope_id=? AND command_id=?').get(scopeId, commandId);
      const snapshot = runSnapshotSchema.parse(JSON.parse(String(admitted?.snapshot)));
      if (snapshot.identity.scopeId !== scopeId || snapshot.identity.runId !== record.proposal.runId
        || encodeCommandProjection('binding', snapshot.proposal) !== encodeCommandProjection('binding', record.binding)
        || encodeCommandProjection('authority', snapshot.authority) !== encodeCommandProjection('authority', record.authority)) throw ErrorRegistry.createError('RUN_PROPOSAL_CORRUPT');
    } catch { throw ErrorRegistry.createError('RUN_PROPOSAL_CORRUPT'); }
  }
  return record;
}
export class SqliteRunProposals {
  constructor(private readonly db: DatabaseSync) {}
  private transaction<T>(work: () => T): T {
    let active = false, committing = false;
    try { this.db.exec('BEGIN IMMEDIATE'); active = true; const value = work(); committing = true; this.db.exec('COMMIT'); return value; }
    catch (error) {
      if (active) { try { this.db.exec('ROLLBACK'); } catch { throw ErrorRegistry.createError('RUN_PROPOSAL_OUTCOME_UNKNOWN'); } }
      if (committing) throw ErrorRegistry.createError('RUN_PROPOSAL_OUTCOME_UNKNOWN');
      if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && ErrorRegistry.has(error.code)) throw error;
      throw ErrorRegistry.createError('RUN_PROPOSAL_STORE_UNAVAILABLE');
    }
  }
  async listIntents(scopeId: string) {
    requireLedgerVersion(this.db, RUN_INTENT_LEDGER_VERSION);
    const rows = this.db.prepare("SELECT command_id FROM run_proposals WHERE scope_id=? AND json_extract(record,'$.kind')='intent' ORDER BY rowid DESC LIMIT 256").all(scopeId);
    return rows.flatMap(row => { const record = readRunProposal(this.db, scopeId, String(row.command_id)); return record && isRunIntent(record) ? [record] : []; });
  }
  async loadProposal(scopeId: string, commandId: string) { return readRunProposal(this.db, scopeId, commandId); }
  async recordProposal(input: RunProposalEnvelope) {
    const record = parseRunProposalEnvelope(input), identity = proposalIdentity(record);
    if (record.schemaVersion === 2) requireLedgerVersion(this.db, RUN_INTENT_LEDGER_VERSION);
    if (record.revision !== 0 || !(isRunIntent(record) ? record.status === 'parked' : ['recorded', 'rejected'].includes(record.status))) throw ErrorRegistry.createError('RUN_PROPOSAL_CORRUPT');
    return this.transaction(() => {
      const previous = readRunProposal(this.db, proposalIdentity(record).scopeId, proposalIdentity(record).commandId);
      if (previous) { if (previous.digest !== record.digest) throw ErrorRegistry.createError('RUN_PROPOSAL_COMMAND_CONFLICT'); return previous; }
      if (this.db.prepare('SELECT command_id FROM run_proposals WHERE scope_id=? AND proposal_id=?').get(proposalIdentity(record).scopeId, proposalIdentity(record).proposalId)) {
        throw ErrorRegistry.createError('RUN_PROPOSAL_COMMAND_CONFLICT');
      }
      this.db.prepare('INSERT INTO run_proposals(scope_id,command_id,proposal_id,run_id,revision,record) VALUES(?,?,?,?,?,?)')
        .run(proposalIdentity(record).scopeId, proposalIdentity(record).commandId, proposalIdentity(record).proposalId, identity.runId, record.revision, JSON.stringify(record));
      this.receiptWithin(record); return record;
    });
  }
  async transitionProposal(previous: RunProposalEnvelope, next: RunProposalEnvelope) { return this.transaction(() => this.transitionWithin(previous, next)); }
  private receiptWithin(record: RunProposalEnvelope) {
    this.db.prepare('INSERT INTO run_proposal_receipts(scope_id,command_id,revision,record) VALUES(?,?,?,?)')
      .run(proposalIdentity(record).scopeId, proposalIdentity(record).commandId, record.revision, JSON.stringify(record));
  }
  private transitionWithin(previousInput: RunProposalEnvelope, nextInput: RunProposalEnvelope) {
    const previous = parseRunProposalEnvelope(previousInput), next = parseRunProposalEnvelope(nextInput), identity = proposalIdentity(previous);
    const current = readRunProposal(this.db, identity.scopeId, identity.commandId);
    const converting = isRunIntent(previous) && !isRunIntent(next);
    if (!current || JSON.stringify(proposalIdentity(next)) !== JSON.stringify(identity) || next.recordedAt !== previous.recordedAt
      || (!converting && next.digest !== previous.digest)) throw ErrorRegistry.createError('RUN_PROPOSAL_COMMAND_CONFLICT');
    if (JSON.stringify(current) === JSON.stringify(next)) return current;
    if (JSON.stringify({ ...current, revision: next.revision }) === JSON.stringify(next)) return current;
    if (JSON.stringify(current) !== JSON.stringify(previous) || next.revision !== previous.revision + 1) throw ErrorRegistry.createError('RUN_PROPOSAL_COMMAND_CONFLICT');
    if (isRunIntent(previous)) {
      if (converting) {
        if (previous.status !== 'starting' || isRunIntent(next) || next.schemaVersion !== 2 || JSON.stringify(next.origin) !== JSON.stringify(previous)
          || next.proposal.source.kind !== 'model' || JSON.stringify(next.proposal.proposer) !== JSON.stringify(previous.proposer)) throw ErrorRegistry.createError('RUN_PROPOSAL_COMMAND_CONFLICT');
      } else if (!isRunIntent(next) || previous.status === 'cancelled' || previous.status === 'starting'
        || next.transitions.length !== previous.transitions.length + 1
        || JSON.stringify(next.transitions.slice(0, -1)) !== JSON.stringify(previous.transitions)) throw ErrorRegistry.createError('RUN_PROPOSAL_COMMAND_CONFLICT');
    } else if (isRunIntent(next) || !['recorded', 'pending'].includes(previous.status)
      || JSON.stringify(next.binding) !== JSON.stringify(previous.binding)) throw ErrorRegistry.createError('RUN_PROPOSAL_COMMAND_CONFLICT');
    const changed = this.db.prepare('UPDATE run_proposals SET revision=?,record=? WHERE scope_id=? AND command_id=? AND revision=?')
      .run(next.revision, JSON.stringify(next), identity.scopeId, identity.commandId, previous.revision);
    if (changed.changes !== 1) throw ErrorRegistry.createError('RUN_PROPOSAL_COMMAND_CONFLICT');
    this.receiptWithin(next); return next;
  }
  /** Called only inside the existing Run transaction, before any Run/intention write. */
  requireWithin(create: RunCreate): RunProposalRecord | null {
    if (!create.proposal) return null;
    const record = readRunProposal(this.db, create.identity.scopeId, create.commandId);
    if (!record || isRunIntent(record) || !['recorded', 'pending'].includes(record.status) || !record.binding.admission
      || record.proposal.runId !== create.identity.runId || JSON.stringify(proposalRunGraph(record.proposal.graph)) !== JSON.stringify(create.graph)
      || encodeCommandProjection('actor', record.proposal.proposer) !== encodeCommandProjection('actor', create.actor)
      || JSON.stringify(record.binding) !== JSON.stringify(create.proposal)) throw ErrorRegistry.createError('RUN_PROPOSAL_COMMAND_CONFLICT');
    if (record.binding.admission.budgetSemantics) {
      const semantics = create.execution.tasks.every(row => classifyWorkSpending({ kind: 'worker', profile: row.profile }) === 'not-metered')
        ? 'not-metered' : 'admission-check-only';
      if (semantics !== record.binding.admission.budgetSemantics) throw ErrorRegistry.createError('RUN_PROPOSAL_BASIS_STALE');
    }
    // The same writer lock protects the admission-time monetary snapshot. No reservation or runtime ceiling is created.
    const budget = record.binding.admission.budget;
    if (record.binding.admission.budgetSemantics === 'not-metered') return record;
    if (!budget) throw ErrorRegistry.createError('RUN_PROPOSAL_CORRUPT');
    const account = this.db.prepare('SELECT record,revision,reservation_count,digest FROM provider_spend_accounts WHERE scope_id=?').get(create.identity.scopeId);
    if (budget.source === 'configured' && !account) return record;
    if (budget.source === 'configured' || !account) throw ErrorRegistry.createError('RUN_PROPOSAL_BASIS_STALE');
    // recheck_ceiling (owner 2026-10-18): exact budget identity/revision/currency, not frozen, and money left still covers the approved ceiling.
    recheckRunProposalBudget(budget, record.proposal.budgetCeiling, { schemaVersion: 2, revision: account.revision, reservationCount: account.reservation_count, digest: account.digest, account: JSON.parse(String(account.record)) });
    return record;
  }
  acceptWithin(previous: RunProposalRecord | null, receipt: RunReceipt): void {
    if (!previous) return;
    if (!receipt.snapshot.authority) throw ErrorRegistry.createError('RUN_PROPOSAL_CORRUPT');
    this.transitionWithin(previous, { ...previous, revision: previous.revision + 1, status: 'accepted', reason: null, approval: null, authority: receipt.snapshot.authority });
  }
}
