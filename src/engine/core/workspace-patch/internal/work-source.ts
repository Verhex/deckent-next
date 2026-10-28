import { ErrorRegistry } from '#platform/index.js';

/**
 * BeUser DR2-05: a Run's work is bound to the source it was made from (its recorded source fingerprint); delivery and adoption act only there.
 * When the configured work source (`now`: the work target, else the project) is another repository, the refusal names both places: `made` is the
 * project folder when the work's fingerprint is the project's, else unknown (an earlier work target). No recorded source (older Runs) checks nothing.
 */
export async function assertSameWorkSource(recorded: string | undefined, places: Readonly<{ now: string; project: string }>, fingerprint: (sourceRoot: string) => Promise<string>) {
  if (recorded === undefined || recorded === await fingerprint(places.now)) return;
  const made = places.project !== places.now && recorded === await fingerprint(places.project).catch(() => null) ? places.project : '';
  throw ErrorRegistry.createError('WORK_TARGET_CHANGED', { params: { now: places.now, made } });
}
