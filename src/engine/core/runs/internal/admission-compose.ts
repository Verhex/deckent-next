import type { RunAdmissionFilter } from './reservation.js';

export function composeRunAdmissionFilters(...filters: readonly RunAdmissionFilter[]): RunAdmissionFilter {
  const active = filters.filter(Boolean);
  if (!active.length) {
    return { async prepare() { return Object.freeze([]); }, excluded() { return Object.freeze([]); } };
  }
  return {
    async prepare(run, principal, now) {
      const excluded = new Set<string>();
      for (const filter of active) for (const taskId of await filter.prepare(run, principal, now)) excluded.add(taskId);
      return Object.freeze([...excluded]);
    },
    excluded(run, actor, now) {
      const excluded = new Set<string>();
      for (const filter of active) for (const taskId of filter.excluded(run, actor, now)) excluded.add(taskId);
      return Object.freeze([...excluded]);
    },
  };
}
