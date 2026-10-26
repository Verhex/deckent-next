import measured from './measured.json' with { type: 'json' };

type Row = Readonly<{ diskGigabytes: number; coldMs: number }>;
const rows = measured.providers as Readonly<Record<string, Row>>;
/** What the image card names for exactly the selected CLIs: the shared base plus each selected provider image, as measured for this
 * package's recipe (IMGOPT 2026-10-26), never the old all-CLI image. A provider without a measured row has no estimate (null), never a guess. */
export function workerImageEstimate(providers: readonly string[]): Readonly<{ sizeGigabytes: number | null; referenceMs: number | null }> {
  if (!providers.length || providers.some(id => !rows[id])) return { sizeGigabytes: null, referenceMs: null };
  const selected = providers.map(id => rows[id]!);
  return { sizeGigabytes: measured.base.diskGigabytes + selected.reduce((sum, row) => sum + row.diskGigabytes, 0),
    referenceMs: measured.base.coldMs + selected.reduce((sum, row) => sum + row.coldMs, 0) };
}
/** The all-CLI estimate (the foreground build of every recipe CLI). */
export const WORKER_IMAGE_ESTIMATED_GB: number = workerImageEstimate(Object.keys(rows)).sizeGigabytes!;
