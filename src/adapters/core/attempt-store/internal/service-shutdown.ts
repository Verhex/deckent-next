import type { DatabaseSync } from 'node:sqlite';
import { identitySchema } from '#domain/index.js';
import {
  sameShutdownAdmission,
  ServiceShutdownError,
  shutdownAdmissionSchema,
  shutdownOutcomeSchema,
  type ServiceShutdownAdmissionResult,
  type ServiceShutdownKey,
  type ServiceShutdownReceipt,
  type ShutdownAdmission,
  type ShutdownOutcome,
} from '#engine/index.js';
import { sqliteFailure } from './options.js';

type StoredRow = Readonly<{ record: unknown }>;

export class SqliteServiceShutdownJournal {
  constructor(private readonly db: DatabaseSync) {}

  async admitServiceShutdown(input: ShutdownAdmission): Promise<ServiceShutdownAdmissionResult> {
    const admission = this.admission(input, 'SERVICE_SHUTDOWN_INVALID');
    const key = this.key({ scopeId: admission.scopeId, serviceId: admission.command.serviceId, commandId: admission.command.commandId });
    let transaction = false;
    try {
      this.db.exec('BEGIN IMMEDIATE'); transaction = true;
      const existing = this.readAdmission(key);
      if (existing) {
        if (!sameShutdownAdmission(existing, admission)) throw new ServiceShutdownError('SERVICE_SHUTDOWN_CONFLICT');
        this.db.exec('COMMIT'); transaction = false;
        return Object.freeze({ admission: existing, replayed: true });
      }
      this.db.prepare('INSERT INTO service_shutdown_commands(scope_id,service_id,command_id,record) VALUES(?,?,?,?)')
        .run(key.scopeId, key.serviceId, key.commandId, JSON.stringify(admission));
      this.db.exec('COMMIT'); transaction = false;
      return Object.freeze({ admission, replayed: false });
    } catch (error) { this.fail(error, transaction); }
  }

  async readServiceShutdown(input: ServiceShutdownKey): Promise<ServiceShutdownReceipt | null> {
    const key = this.key(input);
    try {
      const row = this.db.prepare(`SELECT
        (SELECT record FROM service_shutdown_commands WHERE scope_id=? AND service_id=? AND command_id=?) AS admission_record,
        (SELECT record FROM service_shutdown_outcomes WHERE scope_id=? AND service_id=? AND command_id=?) AS outcome_record`)
        .get(key.scopeId, key.serviceId, key.commandId, key.scopeId, key.serviceId, key.commandId) as
        Readonly<{ admission_record: unknown; outcome_record: unknown }>;
      const admission = row.admission_record === null ? null : this.decodeAdmission(row.admission_record, key);
      const outcome = row.outcome_record === null ? null : this.decodeOutcome(row.outcome_record, key);
      if (!admission) {
        if (outcome) throw new ServiceShutdownError('SERVICE_SHUTDOWN_CORRUPT');
        return null;
      }
      if (outcome && outcome.instanceId !== admission.command.instanceId) throw new ServiceShutdownError('SERVICE_SHUTDOWN_CORRUPT');
      return Object.freeze({ admission, outcome });
    } catch (error) { this.fail(error, false); }
  }

  async retainServiceShutdownOutcome(input: ShutdownOutcome): Promise<ShutdownOutcome> {
    const outcome = this.outcome(input, 'SERVICE_SHUTDOWN_INVALID');
    const key = this.key(outcome);
    let transaction = false;
    try {
      this.db.exec('BEGIN IMMEDIATE'); transaction = true;
      const admission = this.readAdmission(key);
      if (!admission) throw new ServiceShutdownError('SERVICE_SHUTDOWN_NOT_ADMITTED');
      if (admission.command.instanceId !== outcome.instanceId) throw new ServiceShutdownError('SERVICE_SHUTDOWN_INSTANCE');
      const existing = this.readOutcome(key);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(outcome)) throw new ServiceShutdownError('SERVICE_SHUTDOWN_OUTCOME_CONFLICT');
        this.db.exec('COMMIT'); transaction = false;
        return existing;
      }
      this.db.prepare('INSERT INTO service_shutdown_outcomes(scope_id,service_id,command_id,record) VALUES(?,?,?,?)')
        .run(key.scopeId, key.serviceId, key.commandId, JSON.stringify(outcome));
      this.db.exec('COMMIT'); transaction = false;
      return outcome;
    } catch (error) { this.fail(error, transaction); }
  }

  private key(input: ServiceShutdownKey): ServiceShutdownKey {
    const parsed = {
      scopeId: identitySchema.safeParse(input?.scopeId), serviceId: identitySchema.safeParse(input?.serviceId),
      commandId: identitySchema.safeParse(input?.commandId),
    };
    if (!parsed.scopeId.success || !parsed.serviceId.success || !parsed.commandId.success) throw new ServiceShutdownError('SERVICE_SHUTDOWN_INVALID');
    return Object.freeze({ scopeId: parsed.scopeId.data, serviceId: parsed.serviceId.data, commandId: parsed.commandId.data });
  }

  private readAdmission(key: ServiceShutdownKey): ShutdownAdmission | null {
    const row = this.db.prepare('SELECT record FROM service_shutdown_commands WHERE scope_id=? AND service_id=? AND command_id=?')
      .get(key.scopeId, key.serviceId, key.commandId) as StoredRow | undefined;
    if (!row) return null;
    return this.decodeAdmission(row.record, key);
  }

  private decodeAdmission(record: unknown, key: ServiceShutdownKey): ShutdownAdmission {
    const admission = this.admission(record, 'SERVICE_SHUTDOWN_CORRUPT');
    if (admission.scopeId !== key.scopeId || admission.command.serviceId !== key.serviceId || admission.command.commandId !== key.commandId) {
      throw new ServiceShutdownError('SERVICE_SHUTDOWN_CORRUPT');
    }
    return admission;
  }

  private readOutcome(key: ServiceShutdownKey): ShutdownOutcome | null {
    const row = this.db.prepare('SELECT record FROM service_shutdown_outcomes WHERE scope_id=? AND service_id=? AND command_id=?')
      .get(key.scopeId, key.serviceId, key.commandId) as StoredRow | undefined;
    if (!row) return null;
    return this.decodeOutcome(row.record, key);
  }

  private decodeOutcome(record: unknown, key: ServiceShutdownKey): ShutdownOutcome {
    const outcome = this.outcome(record, 'SERVICE_SHUTDOWN_CORRUPT');
    if (outcome.scopeId !== key.scopeId || outcome.serviceId !== key.serviceId || outcome.commandId !== key.commandId) {
      throw new ServiceShutdownError('SERVICE_SHUTDOWN_CORRUPT');
    }
    return outcome;
  }

  private admission(input: unknown, code: 'SERVICE_SHUTDOWN_INVALID' | 'SERVICE_SHUTDOWN_CORRUPT'): ShutdownAdmission {
    try { return shutdownAdmissionSchema.parse(typeof input === 'string' ? JSON.parse(input) : input); }
    catch { throw new ServiceShutdownError(code); }
  }

  private outcome(input: unknown, code: 'SERVICE_SHUTDOWN_INVALID' | 'SERVICE_SHUTDOWN_CORRUPT'): ShutdownOutcome {
    try { return shutdownOutcomeSchema.parse(typeof input === 'string' ? JSON.parse(input) : input); }
    catch { throw new ServiceShutdownError(code); }
  }

  private fail(error: unknown, transaction: boolean): never {
    if (transaction) {
      try { this.db.exec('ROLLBACK'); }
      catch { throw new ServiceShutdownError('SERVICE_SHUTDOWN_CORRUPT'); }
    }
    const mapped = sqliteFailure(error);
    if (mapped instanceof ServiceShutdownError) throw mapped;
    throw new ServiceShutdownError('SERVICE_SHUTDOWN_AUDIT_UNAVAILABLE');
  }
}
