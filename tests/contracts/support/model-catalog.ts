import { readFile } from 'node:fs/promises';

/** The packaged seed document (assets/model-catalog), read fresh for every test so mutations never leak. */
export async function seedCatalog() {
  return JSON.parse(await readFile(new URL('../../../assets/model-catalog/claude-cli-subscription.json', import.meta.url), 'utf8'));
}
export const SEED_CHANNEL = 'claude-cli-subscription';
