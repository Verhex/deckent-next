import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { configCommand, configSlash, renderConfigInspection, renderConfigExplanation } from '#surfaces/core/config/index.js';
import { restartConfigDigest } from '#engine/index.js';
import { loadConfig } from '#platform/index.js';
const field = { key: 'max_workers', value: 2, defaultValue: 'auto', descriptionKey: 'config.field.max_workers', description: 'Workers', schema: { type: 'number' }, source: 'project', binding: { state: 'bound', consumers: ['src/composition/core/runs'] }, apply: 'restart', redacted: false } as const;
const snapshot = { schemaVersion: 1 as const, digest: 'digest', layer: 'project' as const, fields: [field] };
function fixture() {
  const output: string[] = [], inspect = vi.fn(async () => snapshot), explain = vi.fn(async () => field), validate = vi.fn(async () => ({ valid: true as const }));
  const set = vi.fn<(input: Record<string, unknown>) => Promise<Record<string, unknown>>>(async () => ({ keyPath: 'max_workers', layer: 'project', beforeDigest: 'old', afterDigest: 'new', backupPath: 'backup', overridden: true }));
  // T3 L2: the CLI writes through the approval-aware submit; an allowed write is the same set (this stub records what reached it).
  const submit = vi.fn(async (_action: string, input: Record<string, unknown>) => ({ status: 'applied' as const, result: await set(input), approvalId: null }));
  return { output, inspect, explain, set, ctx: { root: '/tmp/config-surface', env: {}, stdout: { write: (s: string) => { output.push(s); } },
    resolveConfigPrincipal: async () => ({ id: 'p', issuer: 'local', subject: 'p', assurance: 'os-user', scopeIds: ['scope-a'] }), configApplication: () => ({ inspect, explain, validate, set, unset: set, submit }) } };
}
describe('registry-driven config surface', () => {
  it('renders readable grouped columns at 80 cells with translated binding/source/apply', () => {
    const en = renderConfigInspection(snapshot, 'en', 80), tr = renderConfigInspection(snapshot, 'tr', 80);
    expect(en).toContain('max_workers'); expect(en).toContain('project'); expect(en).toContain('bound'); expect(en).toContain('restart');
    expect(tr).toContain('proje'); expect(tr).toContain('bağlı'); expect(tr).toContain('yeniden');
    expect(en.split('\n').every(line => Array.from(line).length <= 80)).toBe(true);
  });
  it('bare config dispatches inspect and json is opt-in', async () => {
    const f = fixture(); await configCommand(['config'], f.ctx); expect(f.inspect).toHaveBeenCalled(); expect(f.output.join('')).toContain('max_workers');
    f.output.length = 0; await configCommand(['config', '--json'], f.ctx); expect(JSON.parse(f.output.join(''))).toEqual(snapshot);
  });
  it('explain and validate share application operations', async () => {
    const f = fixture(); await configCommand(['config', 'explain', 'max_workers', '--json'], f.ctx); expect(f.explain).toHaveBeenCalledWith({ keyPath: 'max_workers' });
    expect(JSON.parse(f.output.join('')).schema).toEqual(field.schema);
    f.output.length = 0; await configCommand(['config', 'validate'], f.ctx); expect(f.output.join('')).toMatch(/valid/i);
  });
  it('set sends JSON, explicit target, digest, principal and scope then warns about env override', async () => {
    const f = fixture(); await configCommand(['config', 'set', 'max_workers', '2', '--global', '--expect', 'digest', '--scope', 'scope-a', '--command-id', 'command-a'], f.ctx);
    expect(f.set.mock.calls[0]?.[0]).toMatchObject({ keyPath: 'max_workers', value: 2, layer: 'global', expect: 'digest', scopeId: 'scope-a', commandId: 'command-a' });
    expect(f.set.mock.calls[0]?.[0].principal).toBeDefined(); expect(f.output.join('')).toMatch(/overrid/i);
  });
  it('refuses invalid JSON before calling write and rejects unsupported arguments', async () => {
    const f = fixture(); await expect(configCommand(['config', 'set', 'max_workers', '{', '--scope', 's'], f.ctx)).rejects.toBeDefined(); expect(f.set).not.toHaveBeenCalled();
    await expect(configCommand(['config', 'explain'], f.ctx)).rejects.toBeDefined();
    await expect(configCommand(['config', '--expect', 'd'], f.ctx)).rejects.toBeDefined();
  });
  it('terminal reads the same inspect and refuses malformed or unrouted write syntax (T3 L2: the write route needs the principal port)', async () => {
    const f = fixture(); const lines = await configSlash('/tmp/project', '', f.ctx, {}, 'en', 80); expect(lines.join('\n')).toContain('max_workers');
    for (const args of ['set max_workers', 'set max_workers {', 'unset', 'unset max_workers extra']) expect((await configSlash('/tmp/project', args, f.ctx, {}, 'en', 80)).join('\n')).toContain('/config set');
    expect((await configSlash('/tmp/project', 'set max_workers 2', { ...f.ctx, resolveConfigPrincipal: undefined } as never, {}, 'en', 80)).join('\n')).toContain('read only');
    expect(f.set).not.toHaveBeenCalled();
  });
  it('redacts secret-like values even when a caller supplies unmasked data', () => {
    const s = { ...snapshot, fields: [{ ...field, key: 'terminal.chat.apiKey', value: 'CANARY_SECRET_VALUE', redacted: true }] };
    expect(renderConfigInspection(s, 'en', 80)).not.toContain('CANARY_SECRET_VALUE');
  });
});

it('human configuration values cannot inject terminal control sequences', () => {
  const view = { ...snapshot, fields: [{ ...field, value: 'safe\u001b[2Jvalue\u0007' }] };
  const rendered = renderConfigInspection(view, 'en', 80);
  expect(rendered).not.toContain('\u001b'); expect(rendered).not.toContain('\u0007');
  expect(rendered).toContain('safe'); expect(rendered).toContain('value');
});

it('explain uses the requested locale for the registry description key', () => {
  expect(renderConfigExplanation(field, 'tr', 80)).toContain('kurulum tavanı');
});
it('human explain preserves schema literal alternatives as allowed values', () => {
  const union = { ...field, schema: { anyOf: [{ type: 'string', const: 'none' }, { type: 'string', const: 'bearer' }] } };
  expect(renderConfigExplanation(union, 'en', 80)).toContain('string; none | string; bearer');
});

it('compatible config get --json keeps structured migration warnings on stderr and preserves authored bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'config-get-warning-'));
  try {
    const path = join(root, '.deckent/config.json'), bytes = JSON.stringify({ schema_version: 3, mode: 'balanced' });
    await mkdir(join(root, '.deckent')); await writeFile(path, bytes);
    const stdout: string[] = [], stderr: string[] = [];
    await configCommand(['config', 'get', '--json'], { root, env: { DECKENT_GLOBAL_HOME: join(root, 'global') },
      stdout: { write: value => { stdout.push(value); } }, stderr: { write: value => { stderr.push(value); } } });
    expect(JSON.parse(stdout.join('')).schema_version).toBe(4);
    expect(stderr.join('').trim().split('\n').map(value => JSON.parse(value))).toContainEqual(expect.objectContaining({ code: 'CONFIG_FIELD_RETIRED', path: 'mode' }));
    expect(await readFile(path, 'utf8')).toBe(bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});


it('CLI absent fence reaches set/unset as null and global explain refuses before reading', async () => {
  const f = fixture();
  for (const action of ['set', 'unset']) {
    await configCommand(['config', action, 'max_workers', ...(action === 'set' ? ['2'] : []), '--expect', 'absent', '--global', '--scope', 'scope-a'], f.ctx);
    expect(f.set.mock.calls.at(-1)?.[0]).toMatchObject({ expect: null, layer: 'global' });
  }
  f.explain.mockClear();
  await expect(configCommand(['config', 'explain', 'max_workers', '--global'], f.ctx)).rejects.toMatchObject({ code: 'CLI_USAGE' });
  expect(f.explain).not.toHaveBeenCalled();
});

const HOME_ENV = { HOME: '/tmp/config-surface-home' };
describe('restart-apply change against the running service (K6/#16)', () => {
  const set = async (describeRuntimeService: unknown, language = ['--lang', 'en']) => {
    const f = fixture(); await configCommand(['config', 'set', 'max_workers', '2', '--scope', 'scope-a', ...language], { ...f.ctx, env: HOME_ENV, describeRuntimeService } as never); return f.output.join('');
  };
  it('says restart is required when the service started with other restart-apply values, and names the command', async () => {
    const text = await set(async () => ({ configDigest: '0'.repeat(64) }));
    expect(text).toContain('Restart required'); expect(text).toContain('deckent runtime restart');
    expect(await set(async () => ({ configDigest: '0'.repeat(64) }), ['--lang', 'tr'])).toContain('Yeniden başlatma gerekli');
  });
  it('reports the value as already in use when the digests match, never stale', async () => {
    const digest = restartConfigDigest(await loadConfig('/tmp/config-surface', { env: HOME_ENV, heal: false, force: true }) as never);
    expect(await set(async () => ({ configDigest: digest }))).toContain('already uses this configuration');
  });
  it('is soft: no service answering, or one without a fingerprint, never fails the saved write and never claims stale', async () => {
    const stopped = await set(async () => { throw Object.assign(new Error('x'), { code: 'LOCAL_RUNTIME_UNAVAILABLE' }); });
    expect(stopped).toContain('No service is running'); expect(stopped).not.toContain('Restart required');
    const older = await set(async () => ({}));
    expect(older).toContain('could not be determined'); expect(older).not.toContain('Restart required');
  });
  it('a live field never asks for a restart: the digest ignores language but follows a restart-apply section', () => {
    const base = { language: 'en', service: { maxConnections: 4 }, secretPaths: [] };
    expect(restartConfigDigest({ ...base, language: 'tr' })).toBe(restartConfigDigest(base));
    expect(restartConfigDigest({ ...base, service: { maxConnections: 5 } })).not.toBe(restartConfigDigest(base));
    // The Docker resource ceiling (`execution.docker`) is a restart-apply section: raising it asks for a restart like any other.
    const docker = (memoryBytes: number) => ({ ...base, execution: { docker: { memoryBytes, cpus: 1, pids: 128 } } });
    expect(restartConfigDigest(docker(8_589_934_592))).not.toBe(restartConfigDigest(docker(1_073_741_824)));
  });
});
