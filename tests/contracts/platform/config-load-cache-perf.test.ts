import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { clearConfigCache, loadConfig } from '#platform/core/config/index.js';
import { registerProviderConfig } from '#adapters/core/contract/index.js';
import { fixtureDockerRegistry } from '../support/execution-registry.js';

const roots: string[] = [];
registerProviderConfig();
afterEach(async () => { vi.restoreAllMocks(); clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('shares a deeply frozen resolved config for an unchanged multi-MB registry and reloads a new file stamp', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-config-cache-perf-')); roots.push(root);
  const home = join(root, 'home'), project = join(root, 'project'), projectPath = join(project, '.deckent', 'config.json');
  await mkdir(join(project, '.deckent'), { recursive: true });
  const env = { HOME: home, USERPROFILE: home, APPDATA: join(home, 'roaming'), LOCALAPPDATA: join(home, 'local'), XDG_CONFIG_HOME: join(home, '.config') };
  const base = fixtureDockerRegistry(['fixture']), profile = base.profiles[0]!;
  const profiles = Array.from({ length: 600 }, (_, i) => ({ ...profile, id: `${profile.id}-${i}`,
    parameters: { ...profile.parameters, argv: ['node', 'x'.repeat(6 * 1024)] } }));
  const document = { language: 'en', admission: { registry: { ...base, profiles,
    kinds: base.kinds.map(kind => ({ ...kind, profile: { ...kind.profile, id: profiles[0]!.id } })) },
    poolId: 'perf', executionSlots: 1, inFlightSlots: 1, ordering: 'input-order' } };
  await writeFile(projectPath, JSON.stringify(document));
  expect((await stat(projectPath)).size).toBeGreaterThan(600 * 6 * 1024);
  const first = await loadConfig(project, { env }), clone = vi.spyOn(globalThis, 'structuredClone');
  const second = await loadConfig(project, { env });
  expect(second).toBe(first);
  expect(clone).not.toHaveBeenCalled(); clone.mockRestore();
  expect(Object.isFrozen(first)).toBe(true);
  expect(Object.isFrozen(first.admission)).toBe(true);
  expect(Object.isFrozen(first.admission!.registry)).toBe(true);
  const registry = first.admission!.registry as { profiles: typeof profiles };
  expect(Object.isFrozen(registry.profiles)).toBe(true);
  expect(Object.isFrozen(registry.profiles[0]!.parameters.argv)).toBe(true);
  expect(Object.isFrozen(first.productLayout)).toBe(true);
  expect(Object.isFrozen(first.productLayout.resources)).toBe(true);
  expect(() => { first.inspection.workers.heartbeatMs = 1234; }).toThrow(TypeError);
  expect(() => { registry.profiles[0]!.parameters.argv[1] = 'changed'; }).toThrow(TypeError);
  document.language = 'tr';
  await writeFile(projectPath, JSON.stringify(document));
  const touched = new Date((await stat(projectPath)).mtimeMs + 1000);
  await utimes(projectPath, touched, touched);
  const revised = await loadConfig(project, { env });
  expect(revised).not.toBe(first);
  expect(revised.language).toBe('tr'); expect(first.language).toBe('en');
  expect(await loadConfig(project, { env })).toBe(revised);
});
