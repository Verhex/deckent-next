import { expect, it } from 'vitest';
import { dockerCommand, fixtureContainers, installedScenario } from '../support/installed-runtime-harness.js';

it.skipIf(process.platform !== 'linux').each(['after-arrival'] as const)('contention cleanup leaves no fixture worker when the witness fails %s', async fault => {
  const observed: { root?: string } = {};
  await expect(installedScenario('contention', observed, fault)).rejects.toThrow(`INJECTED_WITNESS_FAULT_${fault.toUpperCase().replace('-', '_')}`);
  expect(observed.root).toBeDefined();
  expect(await fixtureContainers(observed.root!, dockerCommand, true)).toEqual([]);
}, 60_000);
