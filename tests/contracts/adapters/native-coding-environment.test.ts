import { expect, it } from 'vitest';
import { compileNativeCodingDockerProfile, compileNativeCodingWorkInput, createNativeCodingTemplate, resolveDockerTaskProfile } from '#adapters/index.js';
import { encodeExecutionProfileDefinition } from '#domain/index.js';
// PRE-7: the brief's primary case — a native coding TEMPLATE declares environment requirements in its docker part. They survive template
// creation and Run-admission compilation into the frozen task profile, and K3 parity (template-compiled = hand-prepared) still holds.
const environment = { schemaVersion: 1, requirements: [{ id: 'node', kind: 'executable', target: 'node' }, { id: 'typescript', kind: 'path-readable', target: '/node_modules/typescript' },
  { id: 'heap', kind: 'node-heap', target: 'node', expect: '1610612736' }] };
const docker = { imageId: 'sha256:' + 'a'.repeat(64), memoryBytes: 2147483648, pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216,
  deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536, environment };
const invocation = { provider: 'claude', cliVersion: '2.1.293 (Claude Code)', discovery: { schemaVersion: 1, mode: 'repository' }, permissionMode: 'unattended' };
const model = { channelId: 'channel', modelId: 'claude-sonnet-5-5', auxiliaryModelIds: [] };
const workInput = { schemaVersion: 1, task: 'Append "done".', scope: { paths: ['note.txt'] }, acceptance: 'note.txt ends with done.', model };

it('a coding template carries its declared requirements into the compiled task profile, and K3 parity holds with them', () => {
  const template = createNativeCodingTemplate(docker, invocation);
  const compiled = compileNativeCodingWorkInput(template, workInput);
  expect(resolveDockerTaskProfile(compiled).environment).toEqual(environment);
  const hand = compileNativeCodingDockerProfile({ id: template.id, version: template.version, adapter: { id: 'docker', version: 2 }, parameters: { argv: ['unused'], ...docker } },
    { schemaVersion: 4, ...invocation, model, composition: { schemaVersion: 1, task: workInput.task, scope: 'note.txt', acceptance: workInput.acceptance } });
  expect(encodeExecutionProfileDefinition(compiled)).toBe(encodeExecutionProfileDefinition(hand));
});

// PRE-7 phase 2 (lead Q3): `coding template` / `init registry` declare the coding defaults from the adapter registry when the operator
// declared none: node; the typescript path only with a dependency mount at /node_modules; the heap ceiling node-heap.json sets.
it('a template created without a declaration gets the registry defaults; a dependency mount adds typescript; an explicit declaration wins', () => {
  const { environment: _none, ...plain } = docker; void _none;
  const defaults = createNativeCodingTemplate(plain, invocation).parameters['docker'] as { environment?: unknown };
  expect(defaults.environment).toEqual({ schemaVersion: 1, requirements: [{ id: 'node', kind: 'executable', target: 'node' },
    { id: 'node-heap', kind: 'node-heap', target: 'node', expect: String(1536 * 1024 * 1024) }] });
  const mounted = createNativeCodingTemplate({ ...plain, readOnlyMounts: [{ source: 'deps/node_modules', target: '/node_modules' }] }, invocation).parameters['docker'] as { environment?: { requirements: { id: string }[] } };
  expect(mounted.environment!.requirements.map(row => row.id)).toEqual(['node', 'typescript', 'node-heap']);
  expect((createNativeCodingTemplate(docker, invocation).parameters['docker'] as { environment?: unknown }).environment).toEqual(environment);
  // The defaults reach the frozen task profile like any declaration.
  expect(resolveDockerTaskProfile(compileNativeCodingWorkInput(createNativeCodingTemplate(plain, invocation), workInput)).environment).toEqual(defaults.environment);
});

it('negative: a template whose requirement carries a command or an invalid shape is refused at creation', () => {
  for (const bad of [{ schemaVersion: 1, requirements: [{ id: 'x', kind: 'executable', target: 'node', argv: ['sh', '-c', 'id'] }] }, { schemaVersion: 1, requirements: [] }]) {
    expect(() => createNativeCodingTemplate({ ...docker, environment: bad }, invocation)).toThrow(expect.objectContaining({ code: 'NATIVE_CODING_TEMPLATE_INVALID' }));
  }
});
