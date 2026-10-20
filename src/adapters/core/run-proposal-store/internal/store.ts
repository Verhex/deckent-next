import type { DatabaseSync } from 'node:sqlite';
import { encodeCommandProjection, runSnapshotSchema } from '#domain/index.js';
import { parseRunProposalRecord, recheckRunProposalBudget, classifyWorkSpending, proposalRunGraph, type RunProposalRecord, type RunCreate, type RunReceipt } from '#engine/index.js';
import { ErrorRegistry } from '#platform/index.js';
import { requireLedgerVersion, RUN_PROPOSAL_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
export function readRunProposal(db: DatabaseSync, scopeId: string, commandId: string): RunProposalRecord | null {
  requireLedgerVersion(db, RUN_PROPOSAL_LEDGER_VERSION);
  const row = db.prepare('SELECT proposal_id,run_id,revision,record FROM run_proposals WHERE scope_id=? AND command_id=?').get(scopeId, commandId);
  if (!row) return null;
  let record: RunProposalRecord;
  try { record = parseRunProposalRecord(JSON.parse(String(row.record))); } catch { throw ErrorRegistry.createError('RUN_PROPOSAL_CORRUPT'); }
  const receipt = db.prepare('SELECT record FROM run_proposal_receipts WHERE scope_id=? AND command_id=? AND revision=?').get(scopeId, commandId, record.revision);
  if (record.proposal.scopeId !== scopeId || record.proposal.commandId !== commandId || record.proposal.proposalId !== row.proposal_id
    || record.proposal.runId !== row.run_id || record.revision !== row.revision
    || receipt?.record !== row.record) throw ErrorRegistry.createError('RUN_PROPOSAL_CORRUPT');
  if (record.status === 'accepted') {
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
    let active = false;
    try { this.db.exec('BEGIN IMMEDIATE'); active = true; const value = work(); this.db.exec('COMMIT'); return value; }
    catch (error) {
      if (active) { try { this.db.exec('ROLLBACK'); } catch { throw ErrorRegistry.createError('RUN_PROPOSAL_OUTCOME_UNKNOWN'); } }
      if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && ErrorRegistry.has(error.code)) throw error;
      throw ErrorRegistry.createError('RUN_PROPOSAL_STORE_UNAVAILABLE');
    }
  }
  async loadProposal(scopeId: string, commandId: string) { return readRunProposal(this.db, scopeId, commandId); }
  async recordProposal(input: RunProposalRecord) {
    const record = parseRunProposalRecord(input);
    if (record.revision !== 0 || !['recorded', 'rejected'].includes(record.status)) throw ErrorRegistry.createError('RUN_PROPOSAL_CORRUPT');
    return this.transaction(() => {
      const previous = readRunProposal(this.db, record.proposal.scopeId, record.proposal.commandId);
      if (previous) { if (previous.digest !== record.digest) throw ErrorRegistry.createError('RUN_PROPOSAL_COMMAND_CONFLICT'); return previous; }
      if (this.db.prepare('SELECT command_id FROM run_proposals WHERE scope_id=? AND proposal_id=?').get(record.proposal.scopeId, record.proposal.proposalId)) {
        throw ErrorRegistry.createError('RUN_PROPOSAL_COMMAND_CONFLICT');
      }
      this.db.prepare('INSERT INTO run_proposals(scope_id,command_id,proposal_id,run_id,revision,record) VALUES(?,?,?,?,?,?)')
        .run(record.proposal.scopeId, record.proposal.commandId, record.proposal.proposalId, record.proposal.runId, record.revision, JSON.stringify(record));
      this.receiptWithin(record); return record;
    });
  }
  async transitionProposal(previous: RunProposalRecord, next: RunProposalRecord) { return this.transaction(() => this.transitionWithin(previous, next)); }
  private receiptWithin(record: RunProposalRecord) {
    this.db.prepare('INSERT INTO run_proposal_receipts(scope_id,command_id,revision,record) VALUES(?,?,?,?)')
      .run(record.proposal.scopeId, record.proposal.commandId, record.revision, JSON.stringify(record));
  }
  private transitionWithin(previousInput: RunProposalRecord, nextInput: RunProposalRecord) {
    const previous = parseRunProposalRecord(previousInput), next = parseRunProposalRecord(nextInput);
    const current = readRunProposal(this.db, previous.proposal.scopeId, previous.proposal.commandId);
    if (!current || current.digest !== previous.digest || next.digest !== previous.digest
      || JSON.stringify(next.binding) !== JSON.stringify(previous.binding) || next.recordedAt !== previous.recordedAt) throw ErrorRegistry.createError('RUN_PROPOSAL_COMMAND_CONFLICT');
    // A repeated pending observation returns the byte-identical receipt. A concurrent accepted state never regresses.
    if (JSON.stringify({ ...current, revision: next.revision }) === JSON.stringify(next)) return current;
    if (JSON.stringify(current) !== JSON.stringify(previous) || !['recorded', 'pending'].includes(previous.status)
      || next.revision !== previous.revision + 1) throw ErrorRegistry.createError('RUN_PROPOSAL_COMMAND_CONFLICT');
    const changed = this.db.prepare('UPDATE run_proposals SET revision=?,record=? WHERE scope_id=? AND command_id=? AND revision=?')
      .run(next.revision, JSON.stringify(next), previous.proposal.scopeId, previous.proposal.commandId, previous.revision);
    if (changed.changes !== 1) throw ErrorRegistry.createError('RUN_PROPOSAL_COMMAND_CONFLICT');
    this.receiptWithin(next); return next;
  }
  /** Called only inside the existing Run transaction, before any Run/intention write. */
  requireWithin(create: RunCreate): RunProposalRecord | null {
    if (!create.proposal) return null;
    const record = readRunProposal(this.db, create.identity.scopeId, create.commandId);
    if (!record || !['recorded', 'pending'].includes(record.status) || !record.binding.admission
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
