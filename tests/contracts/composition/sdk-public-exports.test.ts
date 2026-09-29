import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
// @ts-expect-error JavaScript build tooling has no declaration file.
import { INVENTORY, inventoryDocument, sdkExports } from '../../../scripts/sdk-exports.mjs';

// DEPS-TYPES (owner 2026-09-29, DEPS-SCHEMA C2-b): the SDK entry is a reviewed surface. Live zod schema objects are not part of it —
// callers could `.parse`/`.extend` them, which made the zod major an SDK contract — while the data types derived from them stay exported.
const REMOVED_ZOD_VALUES = ['CORE_SCHEMA', 'SQLITE_STORAGE_OPTIONS', 'DOCKER_EXECUTION_SETTINGS', 'GIT_EXECUTION_SETTINGS', 'ARTIFACT_STORAGE_LIMITS', 'bootstrapJournalSchema'];
const isZodSchema = (value: unknown) => typeof value === 'object' && value !== null && (value as { '~standard'?: { vendor?: unknown } })['~standard']?.vendor === 'zod';

it('the SDK entry exports exactly the reviewed inventory of names', async () => {
  const committed = JSON.parse(await readFile(INVENTORY, 'utf8')) as unknown;
  // On a deliberate SDK change: `node scripts/sdk-exports.mjs --write`, review the diff, and add a CHANGELOG BREAKING line for any removal.
  expect(inventoryDocument(sdkExports())).toEqual(committed);
}, 60_000);

it('publishes no live zod schema, and keeps the types derived from the removed ones', async () => {
  const inventory = sdkExports() as Record<string, 'value' | 'type'>;
  expect(REMOVED_ZOD_VALUES.filter(name => name in inventory)).toEqual([]);
  expect(Object.entries(await import('../../../src/index.js')).filter(([, value]) => isZodSchema(value)).map(([name]) => name)).toEqual([]);
  expect(['CoreConfig', 'DeckentConfig', 'BootstrapJournal', 'BootstrapJournalPayload'].map(name => [name, inventory[name]]))
    .toEqual([['CoreConfig', 'type'], ['DeckentConfig', 'type'], ['BootstrapJournal', 'type'], ['BootstrapJournalPayload', 'type']]);
}, 60_000);
