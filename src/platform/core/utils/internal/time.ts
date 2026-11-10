export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return [hours, minutes, seconds % 60].map(value => String(value).padStart(2, '0')).join(':');
}
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export function estimateRemaining(elapsedMs: number, completed: number, total: number): number | null {
  return completed > 0 && elapsedMs >= 0 ? Math.max(0, elapsedMs / completed * (total - completed)) : null;
}
