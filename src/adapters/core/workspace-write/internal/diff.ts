import { unifiedDiff as diff } from '#platform/index.js';
/** Keep the adapter's preview entry on the shared bounded text comparison. */
export function unifiedDiff(path: string, before: string | null, after: string | null): string { return diff(path, before, after); }
