import type { AuditApplication } from '#engine/core/audit/index.js';

/** Only sealed, contiguous project-config transitions may advance a committed first-session publication. */
export function publishedConfigProgress(audit: Pick<AuditApplication, 'list'>, scopeId: string, initial: string, current: string, limits: { readonly pageSize: number; readonly maxRecords: number }): boolean {
  let revisionDigest = initial, afterSequence = 0, previous: string | null = null;
  for (;;) {
    const page = audit.list(scopeId, afterSequence, limits.pageSize);
    for (const { event, sequence } of page) {
      if (sequence > limits.maxRecords) return false;
      const change = event.subject;
      if (change.kind !== 'config-change' || change.layer !== 'project') continue;
      if (change.beforeDigest === revisionDigest) { previous = revisionDigest; revisionDigest = change.afterDigest; }
      // One atomic multi-field config write records one event per field with the same before/after pair.
      else if (change.beforeDigest !== previous || change.afterDigest !== revisionDigest) return false;
    }
    if (page.length < limits.pageSize) return revisionDigest === current;
    afterSequence = page.at(-1)!.sequence;
  }
}
