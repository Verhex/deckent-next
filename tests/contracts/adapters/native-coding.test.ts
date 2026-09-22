import { expect, it } from 'vitest';
import { compileNativeCodingDockerProfile, resolveDockerTaskProfile } from '#adapters/index.js';

const template = () => ({ id: 'coding', version: 1, adapter: { id: 'docker', version: 2 }, parameters: {
  argv: ['unused'], imageId: 'sha256:' + 'a'.repeat(64), memoryBytes: 268435456,
  pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216,
  deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536,
} });
const invocation = (provider = 'codex') => ({ schemaVersion: 2, provider, cliVersion: 'fixture-1', discovery: { schemaVersion: 1, mode: 'repository' }, permissionMode: 'unattended',
  model: 'configured-model', prompt: '--config dangerous=true; $(touch /outside)' });
const composition = () => ({ schemaVersion: 1, persona: { id: 'reviewer', version: 2, text: 'Check the change.' },
  skills: [{ id: 'editing', version: 1, text: 'Preserve unrelated files.' }],
  context: [{ id: 'project', version: 3, text: 'A tiny fixture.' }],
  task: 'Edit note.txt.', scope: 'Only note.txt.', acceptance: 'Exact contents verified.' });
const composed = (provider = 'codex') => ({ ...invocation(provider), prompt: undefined, composition: composition() });

it.each(['codex', 'claude', 'cursor'])('binds deterministic selected content and native delivery for %s without content in Docker argv', provider => {
  const profile = compileNativeCodingDockerProfile(template(), composed(provider));
  const resolved = resolveDockerTaskProfile(profile);
  const delivery = resolved.nativeSubscription!.promptDelivery!;
  expect(compileNativeCodingDockerProfile(template(), composed(provider))).toEqual(profile);
  expect(delivery.core).toContain('deckent-worker-core@1');
  expect(delivery.task).toContain('persona:reviewer@2');
  expect(delivery.task).toContain('skill:editing@1');
  expect(delivery.segments.map(s => s.kind)).toEqual(['core', 'persona', 'skill', 'context', 'task', 'scope', 'acceptance']);
  expect(resolved.argv.at(-1)).toBe('__DECKENT_TASK_PROMPT__');
  expect(JSON.stringify(resolved.argv)).not.toContain('Edit note.txt.');
  expect(delivery.channel).toBe({ codex: 'codex-instructions-file', claude: 'claude-system-prompt', cursor: 'inline' }[provider]);
  const changed = composed(provider); changed.composition.task = 'A different task.';
  const next = resolveDockerTaskProfile(compileNativeCodingDockerProfile(template(), changed)).nativeSubscription!.promptDelivery!;
  expect(next.sha256).not.toBe(delivery.sha256);
  expect(next.segments.filter(s => s.kind !== 'task')).toEqual(delivery.segments.filter(s => s.kind !== 'task'));
});

it('rejects ambiguous, duplicate, oversized or implicit prompt selections', () => {
  for (const request of [
    { ...composed(), prompt: 'ambiguous' }, { ...invocation(), prompt: undefined },
    { ...composed(), composition: { ...composition(), skills: [composition().persona] } },
    { ...composed(), composition: { ...composition(), context: [composition().context[0], composition().context[0]] } },
    { ...composed(), composition: { ...composition(), task: 'ü'.repeat(8193) } },
    { ...composed(), composition: { ...composition(), task: ' '.repeat(10) } },
    { ...composed(), composition: { ...composition(), catalogPath: '/host/private' } },
    { ...composed(), composition: { ...composition(), task: 'a'.repeat(16000), scope: 'b'.repeat(16000), acceptance: 'c'.repeat(1000) } },
  ]) expect(() => compileNativeCodingDockerProfile(template(), request)).toThrow('NATIVE_CODING_INVOCATION_INVALID');
});

it('refuses changed content, receipt metadata and argv at profile resolution', () => {
  const original = compileNativeCodingDockerProfile(template(), composed());
  const p = original.parameters;
  const binding = resolveDockerTaskProfile(original).nativeSubscription!;
  for (const parameters of [
    { ...p, nativeSubscription: { ...binding, promptDelivery: { ...binding.promptDelivery!, core: 'changed' } } },
    { ...p, nativeSubscription: { ...binding, promptDelivery: { ...binding.promptDelivery!, segments: [] } } },
    { ...p, argv: ['foreign'] },
  ]) expect(() => resolveDockerTaskProfile({ ...original, parameters })).toThrow('DOCKER_TASK_PROFILE_INVALID');
});

it.each(['codex', 'claude', 'cursor'])('compiles %s into the existing pinned Docker execution contract without shell interpretation', provider => {
  const source = template();
  const result = compileNativeCodingDockerProfile(source, invocation(provider));
  const { argv, options } = resolveDockerTaskProfile(result);
  expect(argv.at(-2)).toBe('--');
  expect(argv.at(-1)).toBe(invocation().prompt);
  expect(argv[argv.indexOf('--model') + 1]).toBe('configured-model');
  expect(argv).not.toContain('ask');
  expect(options.imageId).toBe(source.parameters.imageId);
  expect(result.adapter).toEqual(source.adapter);
  expect(result.version).toBe(source.version);
  expect(source.parameters.argv).toEqual(['unused']);
  source.parameters.memoryBytes = 1;
  expect(options.memoryBytes).toBe(268435456);
});

it.each([
  { provider: 'unknown' }, { model: '-override' }, { model: '' }, { prompt: '\0' },
  { prompt: 'ü'.repeat(32769) }, { permissionMode: 'auto' }, { schemaVersion: 1 }, { secret: 'never-forward' },
])('rejects unsupported or unsafe invocation data without fallback: %j', change => {
  expect(() => compileNativeCodingDockerProfile(template(), { ...invocation(), ...change }))
    .toThrow('NATIVE_CODING_INVOCATION_INVALID');
});

it('rejects mutable image references and non-Docker templates', () => {
  const mutable = template(); mutable.parameters.imageId = 'latest';
  expect(() => compileNativeCodingDockerProfile(mutable, invocation())).toThrow('NATIVE_CODING_TEMPLATE_INVALID');
  const other = template(); other.adapter.id = 'process';
  expect(() => compileNativeCodingDockerProfile(other, invocation())).toThrow('NATIVE_CODING_TEMPLATE_INVALID');
});


it('defaults Claude to discovery disabled without silently changing an old authoring request', () => {
  const request = { ...invocation('claude'), discovery: undefined };
  const result = compileNativeCodingDockerProfile(template(), request);
  const profile = resolveDockerTaskProfile(result);
  expect(profile.argv).toContain('--safe-mode');
  expect(profile.argv).not.toContain('--bare');
  expect(profile.nativeSubscription?.preflight).toMatchObject({ cliVersion: 'fixture-1', discovery: 'disabled' });
  expect(() => compileNativeCodingDockerProfile(template(), { ...request, schemaVersion: 1 })).toThrow('NATIVE_CODING_INVOCATION_INVALID');
});

it.each(['codex', 'cursor'])('rejects unverified %s discovery suppression instead of falling back to repository discovery', provider => {
  expect(() => compileNativeCodingDockerProfile(template(), { ...invocation(provider), discovery: undefined }))
    .toThrow('NATIVE_CODING_DISCOVERY_UNSUPPORTED');
});

it('pins only typed non-secret explicit settings and refuses unsupported settings semantics', () => {
  const discovery = { schemaVersion: 1, mode: 'repository', settings: { disableAllHooks: true } };
  const result = resolveDockerTaskProfile(compileNativeCodingDockerProfile(template(), { ...invocation('claude'), discovery }));
  expect(result.argv[result.argv.indexOf('--settings') + 1]).toBe('{"disableAllHooks":true}');
  expect(result.nativeSubscription?.preflight?.requiredFlags).toContain('--settings');
  for (const settings of [{ apiKeyHelper: 'never-run' }, { env: { ANTHROPIC_API_KEY: 'never-forward' } }, '/host/settings.json', { disableAllHooks: true, hooks: {} }]) {
    expect(() => compileNativeCodingDockerProfile(template(), { ...invocation('claude'), discovery: { ...discovery, settings } }))
      .toThrow('NATIVE_CODING_INVOCATION_INVALID');
  }
  for (const provider of ['codex', 'cursor']) expect(() => compileNativeCodingDockerProfile(template(), { ...invocation(provider), discovery }))
    .toThrow('NATIVE_CODING_DISCOVERY_UNSUPPORTED');
  expect(() => compileNativeCodingDockerProfile(template(), { ...invocation('claude'), discovery: { ...discovery, mode: 'disabled' } }))
    .toThrow('NATIVE_CODING_DISCOVERY_UNSUPPORTED');
});

it('preserves previously pinned profiles without adding discovery or preflight at replay', () => {
  const old = { ...template(), parameters: { ...template().parameters, argv: ['claude', '--print', 'old-task'], nativeSubscription: { schemaVersion: 1, provider: 'claude' } } };
  const profile = resolveDockerTaskProfile(old);
  expect(profile.argv).toEqual(['claude', '--print', 'old-task']);
  expect(profile.nativeSubscription?.preflight).toBeUndefined();
});
