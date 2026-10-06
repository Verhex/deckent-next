import { expect, it } from 'vitest';
import { dockerCommand, fixtureContainers, installedScenario, settleScenario, type DockerCommand } from '../support/installed-runtime-harness.js';

it('the cleanup oracle fails on cleanup errors and on uninspectable running containers', async () => {
  expect(() => settleScenario(undefined, [new Error('INJECTED_CLEANUP_FAULT')])).toThrow('CONTENTION_CLEANUP_FAILED');
  const combined = (() => { try { settleScenario({ error: new Error('PRIMARY') }, [new Error('INJECTED_CLEANUP_FAULT')]); } catch (error) { return error as AggregateError; } })();
  expect(combined?.message).toBe('SCENARIO_AND_CLEANUP_FAILED'); expect(combined?.errors.map(error => (error as Error).message)).toEqual(['PRIMARY', 'INJECTED_CLEANUP_FAULT']);
  expect(() => settleScenario({ error: new Error('PRIMARY') }, [])).toThrow('PRIMARY');
  expect(() => settleScenario(undefined, [])).not.toThrow();
  const fake = (running: string[], inspectable: Record<string, string>): DockerCommand => async args => {
    if (args[0] === 'ps') return { stdout: (args.includes('--filter') ? running.filter(id => args.at(-1) === `id=${id}`) : running).join('\n') };
    const mounts = inspectable[String(args.at(-1))]; if (mounts === undefined) throw new Error('inspect failed'); return { stdout: mounts };
  };
  await expect(fixtureContainers('/tmp/root-a', fake(['c1'], {}))).rejects.toThrow('FIXTURE_CONTAINER_UNINSPECTABLE:c1');
  const vanishing: DockerCommand = async args => args[0] === 'ps' ? { stdout: args.includes('--filter') ? '' : 'c1' } : Promise.reject(new Error('gone'));
  await expect(fixtureContainers('/tmp/root-a', vanishing)).resolves.toEqual([]);
  await expect(fixtureContainers('/tmp/root-a', fake(['c1', 'c2'], { c1: '/tmp/root-a/data ', c2: '/other ' }))).resolves.toEqual(['c1']);
});

it.skipIf(process.platform !== 'linux').each(['before-dispatch'] as const)('contention cleanup leaves no fixture worker when the witness fails %s', async fault => {
  const observed: { root?: string } = {};
  await expect(installedScenario('contention', observed, fault)).rejects.toThrow(`INJECTED_WITNESS_FAULT_${fault.toUpperCase().replace('-', '_')}`);
  expect(observed.root).toBeDefined();
  expect(await fixtureContainers(observed.root!, dockerCommand, true)).toEqual([]);
}, 60_000);
