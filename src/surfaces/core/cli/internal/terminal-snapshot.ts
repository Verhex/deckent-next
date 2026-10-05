import type { SurfaceSnapshotAccess, SurfacePublicationKind, RunView, WorkerObservationReport } from '#engine/index.js';
import type { WorklineLedgerPorts, WorklineSurfaceSnapshot, WorklineApproval } from '#surfaces/core/terminal/index.js';

export function withSurfaceSnapshot(ports: WorklineLedgerPorts, access: (() => Promise<SurfaceSnapshotAccess | null>) | undefined): WorklineLedgerPorts {
  if (!access) return ports;
  return { ...ports, readSurfaceSnapshot: async (kinds: readonly SurfacePublicationKind[], signal: AbortSignal): Promise<WorklineSurfaceSnapshot> => {
    const denied = new Set<SurfacePublicationKind>();
    const admitted = signal.aborted ? null : await access();
    const data: { runs?: readonly RunView[]; workers?: WorkerObservationReport; approvals?: readonly WorklineApproval[] } = {};
    for (const kind of new Set(kinds)) {
      if (signal.aborted) break;
      const current = await access();
      if (!admitted || current?.binding !== admitted.binding || !current.kinds.includes(kind)) { denied.add(kind); continue; }
      if (signal.aborted) break;
      try {
        if (kind === 'worker') data.workers = await ports.listWorkers();
        // The terminal and approval-presentation barrels carry the Ink/React UI; the CLI entry graph reaches them only when a snapshot reads.
        if (kind === 'run') data.runs = await (await import('#surfaces/core/terminal/index.js')).loadRunViewsForWatch(ports);
        if (kind === 'approval' && ports.listApprovalPage) data.approvals = (await (await import('#surfaces/core/approval-presentation/index.js')).scanPendingApprovals(ports.listApprovalPage, Date.now())).pending;
      } catch (error) {
        if (['POLICY_DENIED', 'POLICY_APPROVAL_UNSUPPORTED', 'SCOPE_UNKNOWN', 'APPROVAL_DENIED'].includes(String((error as { code?: unknown })?.code))) denied.add(kind);
        else throw error;
      }
    }
    // Recheck all requested kinds after the awaits, including kinds read before a later revocation.
    const current = signal.aborted ? null : await access();
    const allowed = admitted && current?.binding === admitted.binding ? current.kinds : [];
    for (const kind of kinds) if (!allowed.includes(kind)) denied.add(kind);
    return { scopeId: ports.scopeId, denied: [...denied],
      ...(!denied.has('run') && data.runs ? { runs: data.runs } : {}),
      ...(!denied.has('worker') && data.workers ? { workers: data.workers } : {}),
      ...(!denied.has('approval') && data.approvals ? { approvals: data.approvals } : {}) };
  } };
}
