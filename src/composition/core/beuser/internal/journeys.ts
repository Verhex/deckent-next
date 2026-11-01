import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BEUSER_PACKAGE_ROOT } from './setup.js';

/** The shipped journey files own both the list and recommendation metadata. */
export async function listConfiguredBeuserJourneys() {
  const directory = join(BEUSER_PACKAGE_ROOT, 'assets', 'beuser', 'journeys');
  const names = (await readdir(directory)).filter(name => /^[a-z0-9][a-z0-9-]{0,63}\.json$/u.test(name)).sort();
  return Promise.all(names.map(async name => {
    const data = JSON.parse(await readFile(join(directory, name), 'utf8')) as { journeyId: string; recommended?: boolean };
    return { id: data.journeyId, recommended: data.recommended === true };
  }));
}
