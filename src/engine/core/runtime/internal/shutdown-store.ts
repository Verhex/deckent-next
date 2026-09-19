import type { ShutdownAdmission, ShutdownOutcome } from './shutdown-contract.js';

export interface ServiceShutdownKey { readonly scopeId: string; readonly serviceId: string; readonly commandId: string }
export interface ServiceShutdownReceipt { readonly admission: ShutdownAdmission; readonly outcome: ShutdownOutcome | null }
export interface ServiceShutdownAdmissionResult { readonly admission: ShutdownAdmission; readonly replayed: boolean }

/** Atomic canonical admission is both command receipt and admission audit; external forwarding is downstream. */
export interface ServiceShutdownStore {
  admitServiceShutdown(admission: ShutdownAdmission): Promise<ServiceShutdownAdmissionResult>;
  readServiceShutdown(key: ServiceShutdownKey): Promise<ServiceShutdownReceipt | null>;
  retainServiceShutdownOutcome(outcome: ShutdownOutcome): Promise<ShutdownOutcome>;
  close(): void;
}

export class ServiceShutdownError extends Error {
  constructor(readonly code: 'SERVICE_SHUTDOWN_INVALID' | 'SERVICE_SHUTDOWN_CONFLICT' | 'SERVICE_SHUTDOWN_INSTANCE'
    | 'SERVICE_SHUTDOWN_AUDIT_UNAVAILABLE' | 'SERVICE_SHUTDOWN_CORRUPT' | 'SERVICE_SHUTDOWN_NOT_ADMITTED'
    | 'SERVICE_SHUTDOWN_OUTCOME_CONFLICT') {
    super(code); this.name = 'ServiceShutdownError';
  }
}
