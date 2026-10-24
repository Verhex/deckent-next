import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigApplication } from '#engine/index.js';
import { createConfigFileDocuments } from '#adapters/index.js';
import { composeCore } from '#composition/core/root/index.js';
import { configCommand, configPanelPort, configSlash, type ConfigCommandContext } from '#surfaces/core/config/index.js';
import { ErrorRegistry, t } from '#platform/index.js';

/**
 * alpha.55.1 hotfix (functest B P1): a write that changes a protected config root is a person's act at a terminal, the same witness as the other
 * person-only commands (`memory propose`, `agents define`, `models login`): the surface refuses the AI marker, CI, a pipe and `--json`, and the
 * engine's human write path (`submit`) asks the composition's terminal witness before anything is read, planned, approved or written.
 * Non-protected keys keep today's behaviour.
 */
const PROTECTED: readonly (readonly [string, string, readonly string[]])[] = [
  ['memoryAutomation.extraction.mode', '"shadow"', []], ['memoryAutomation.verification.mode', '"shadow"', []], ['memoryAutomation.context.mode', '"shadow"', []],
  ['runRuntime.nervous.mode', '"shadow"', []], ['runRuntime.recovery.mode', '"shadow"', []], ['catalogEvolution.mode', '"shadow"', []],
  ['models.headless.preview', 'true', []], ['identity.profile', '{"id":"core:solo","version":1}', ['--global']], ['execution.docker.imageId', `"sha256:${'a'.repeat(64)}"`, []],
  ['policy', '{}', []], ['terminal.shell.realm', '"none"', []], ['admission.registry', '{}', []],
];
const TTY = { isTTY: true } as const, PIPE = { isTTY: false } as const;
const person = { env: { TERM: 'xterm-256color' }, stdin: TTY };
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

function stub(io: { env: NodeJS.ProcessEnv; stdin: { isTTY: boolean }; stdoutTty?: boolean }) {
  const output: string[] = [], submit = vi.fn(async () => ({ status: 'applied' as const, result: { keyPath: 'k', layer: 'project', beforeDigest: null, afterDigest: 'a', backupPath: null, overridden: false }, approvalId: null }));
  const explain = vi.fn(async () => ({ key: 'k', value: null, defaultValue: null, source: 'default', descriptionKey: 'x.none', description: 'x', schema: { type: 'string' },
    binding: { state: 'bound', consumers: [] }, apply: 'live', redacted: false })), loadInstallationIdentity = vi.fn(async () => undefined), resolveConfigPrincipal = vi.fn(async () => ({ id: 'p', issuer: 'local-os', subject: '1000', assurance: 'os-user', scopeIds: ['s'] }));
  const ctx = { root: '/tmp/config-protected-witness', env: io.env, stdin: io.stdin, stdout: { isTTY: io.stdoutTty ?? io.stdin.isTTY, write: (text: string) => { output.push(text); } },
    loadInstallationIdentity, resolveConfigPrincipal, configApplication: () => ({ explain, submit, inspect: vi.fn(), validate: vi.fn() }) } as unknown as ConfigCommandContext;
  return { ctx, submit, resolveConfigPrincipal, output };
}
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; params?: Record<string, unknown>; message?: string }) => error);

describe('CLI config set/unset of a protected root needs the person at a terminal', () => {
  it.each(PROTECTED)('%s: AI marker (CLAUDECODE=1 on a real terminal) is refused before any read or write', async (key, value, extra) => {
    const f = stub({ env: { ...person.env, CLAUDECODE: '1' }, stdin: TTY });
    const error = await refusal(configCommand(['config', 'set', key, value, '--scope', 's', ...extra], f.ctx));
    expect(error).toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED', params: { operation: `config set ${key}` } });
    expect(f.submit).not.toHaveBeenCalled(); expect(f.resolveConfigPrincipal).not.toHaveBeenCalled();
    const unset = await refusal(configCommand(['config', 'unset', key, '--scope', 's', ...extra], f.ctx));
    expect(unset).toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED', params: { operation: `config unset ${key}` } }); expect(f.submit).not.toHaveBeenCalled();
  });
  it('a pipe, CI, TERM=dumb and --json are refused; the message names the setting and the next step in EN and TR', async () => {
    for (const io of [{ env: person.env, stdin: PIPE }, { env: { ...person.env, CI: 'true' }, stdin: TTY }, { env: { TERM: 'dumb' }, stdin: TTY }, { env: person.env, stdin: TTY, stdoutTty: false }]) {
      const f = stub(io);
      expect(await refusal(configCommand(['config', 'set', 'runRuntime.nervous.mode', '"shadow"', '--scope', 's'], f.ctx))).toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
      expect(f.submit).not.toHaveBeenCalled();
    }
    const json = stub({ env: person.env, stdin: TTY });
    expect(await refusal(configCommand(['config', 'set', 'catalogEvolution.mode', '"shadow"', '--scope', 's', '--json'], json.ctx))).toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    expect(json.submit).not.toHaveBeenCalled();
    const en = t('security.witness.config', { key: 'catalogEvolution.mode' }, 'en'), tr = t('security.witness.config', { key: 'catalogEvolution.mode' }, 'tr');
    expect(en).toContain('catalogEvolution.mode'); expect(en).toMatch(/your own terminal/u); expect(tr).toContain('catalogEvolution.mode'); expect(tr).toMatch(/kendi terminalinizde/u);
  });
  it('a non-protected key keeps today\'s behaviour under the AI marker and through a pipe', async () => {
    for (const io of [{ env: { ...person.env, CLAUDECODE: '1' }, stdin: TTY }, { env: person.env, stdin: PIPE }]) {
      const f = stub(io);
      await configCommand(['config', 'set', 'max_workers', '2', '--scope', 's'], f.ctx);
      expect(f.submit).toHaveBeenCalledWith('set', expect.objectContaining({ keyPath: 'max_workers', value: 2 }));
    }
  });
  it('the person at a real terminal reaches the governed write (the engine then asks the terminal witness)', async () => {
    const f = stub({ env: person.env, stdin: TTY });
    await configCommand(['config', 'set', 'memoryAutomation.extraction.mode', '"shadow"', '--scope', 's'], f.ctx);
    expect(f.submit).toHaveBeenCalledWith('set', expect.objectContaining({ keyPath: 'memoryAutomation.extraction.mode', value: 'shadow' }));
  });
  it('value-missing stays a read-only refusal (no write is attempted)', async () => {
    const f = stub({ env: { ...person.env, CLAUDECODE: '1' }, stdin: PIPE });
    expect(await refusal(configCommand(['config', 'set', 'execution.docker.imageId'], f.ctx))).toMatchObject({ code: 'CLI_CONFIG_VALUE_MISSING' });
  });
});

async function terminalRoot() {
  composeCore();
  const root = await mkdtemp(join(tmpdir(), 'config-witness-')); roots.push(root);
  await mkdir(join(root, '.deckent'), { recursive: true }); await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ terminal: { scopeId: 'scope' } }));
  return { root, options: { env: { HOME: root, DECKENT_GLOBAL_HOME: join(root, 'global') }, heal: false } };
}
/** The engine's real write path over the file documents; the terminal witness is the port under test (`attest`). */
function engine(root: string, options: { env: NodeJS.ProcessEnv; heal: boolean }, attest: boolean | null) {
  const documents = createConfigFileDocuments(root, options), audits: unknown[] = [], asked: string[] = [];
  const app = new ConfigApplication(documents, { authorize: async () => 'p1', audit: async event => { audits.push(event); },
    approvals: { evaluate: async () => ({ decision: 'allow', revision: 'p1', ruleId: 'rule' }), admit: async () => { throw new Error('unused'); } },
    ...(attest === null ? {} : { witness: async (operation: string) => { asked.push(operation); if (!attest) throw ErrorRegistry.createError('AUTHORITY_WITNESS_REQUIRED', { params: { operation } }); } }) });
  return { app, audits, asked };
}
const principal = { id: 'owner', issuer: 'local-os', subject: '1000', assurance: 'os-user', scopeIds: ['scope'] } as never;

describe('terminal /config (slash, window, records) under the AI marker', () => {
  it('slash and window refuse a protected key with the AI marker even on a real terminal; nothing is written', async () => {
    const { root, options } = await terminalRoot(), before = await readFile(join(root, '.deckent/config.json'), 'utf8');
    const f = engine(root, options, true);
    const ctx: ConfigCommandContext = { env: { ...options.env, TERM: 'xterm-256color', CLAUDECODE: '1' }, stdin: TTY, stdout: TTY as never, configApplication: () => f.app, resolveConfigPrincipal: async () => principal };
    expect(await refusal(configSlash(root, 'set runRuntime.recovery.mode "shadow"', ctx, options, 'en', 80))).toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    expect(await refusal(configSlash(root, 'memoryAutomation.context.mode=shadow', ctx, options, 'en', 80))).toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    expect(await refusal(configPanelPort(root, ctx, options, 'en').write({ action: 'set', keyPath: 'catalogEvolution.mode', value: 'shadow', layer: 'project' })))
      .toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    expect(await readFile(join(root, '.deckent/config.json'), 'utf8')).toBe(before); expect(f.audits).toEqual([]); expect(f.asked).toEqual([]);
    // A non-protected key in the same window keeps today's behaviour.
    expect((await configSlash(root, 'set max_workers 2', ctx, options, 'en', 80)).join('\n')).toContain('max_workers');
  });
  it('the person on a real terminal writes a protected key through the window once the witness attests', async () => {
    const { root, options } = await terminalRoot(), f = engine(root, options, true);
    const ctx: ConfigCommandContext = { env: { ...options.env, TERM: 'xterm-256color' }, stdin: TTY, stdout: TTY as never, configApplication: () => f.app, resolveConfigPrincipal: async () => principal };
    await configPanelPort(root, ctx, options, 'en').write({ action: 'set', keyPath: 'runRuntime.nervous.mode', value: 'shadow', layer: 'project' });
    expect(JSON.parse(await readFile(join(root, '.deckent/config.json'), 'utf8')).runRuntime.nervous.mode).toBe('shadow');
    expect(f.asked).toEqual(['config set runRuntime.nervous.mode']); expect(f.audits).toHaveLength(1);
  });
});

describe('engine: the human write path (submit) asks the terminal witness for a protected root, before anything', () => {
  it('no witness port fails closed; a refusing witness writes nothing; a non-protected key never asks', async () => {
    const { root, options } = await terminalRoot(), before = await readFile(join(root, '.deckent/config.json'), 'utf8');
    const write = { keyPath: 'memoryAutomation.extraction.mode', value: 'shadow', layer: 'project' as const, principal, scopeId: 'scope', commandId: 'c1' };
    const none = engine(root, options, null);
    expect(await refusal(none.app.submit('set', write))).toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED', params: { operation: 'config set memoryAutomation.extraction.mode' } });
    const refused = engine(root, options, false);
    expect(await refusal(refused.app.submit('unset', { ...write, commandId: 'c2' }))).toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    // An ancestor whose whole-object write would replace a protected root is protected too.
    expect(await refusal(refused.app.submit('set', { ...write, keyPath: 'runRuntime', value: {}, commandId: 'c3' }))).toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    expect(await readFile(join(root, '.deckent/config.json'), 'utf8')).toBe(before); expect(refused.audits).toEqual([]);
    expect((await refused.app.submit('set', { ...write, keyPath: 'max_workers', value: 2, commandId: 'c4' })).status).toBe('applied'); expect(refused.asked).toEqual(['config unset memoryAutomation.extraction.mode', 'config set runRuntime']);
  });
});

describe('alpha.56 recovery cards: the blind review and a recovery policy change are a person\'s at a terminal', () => {
  it('review refuses the AI marker, CI, a pipe, TERM=dumb and --json before anything is read; policy recovery off a terminal only reads', async () => {
    const { recoveryCommand, policyRecoveryCommand } = await import('#surfaces/core/cli-approval/index.js');
    const calls: string[] = [], output: string[] = [];
    const recovery = { inspectRollout: vi.fn(), changePolicy: vi.fn(async () => { calls.push('change'); return null as never; }),
      reviewPending: vi.fn(async () => { calls.push('pending'); return []; }), reviewAnswer: vi.fn(async () => { calls.push('answer'); return null as never; }),
      inspectPolicy: vi.fn(async () => { calls.push('inspect'); return { schemaVersion: 1, scopeId: 's', revision: 'r', rows: [], rollout: {} } as never; }) };
    const ctx = (env: NodeJS.ProcessEnv, stdin: { isTTY: boolean }) => ({ root: '/tmp/recovery-witness', env: { ...env, HOME: '/tmp/recovery-witness-home' }, stdin, recovery,
      stdout: { isTTY: stdin.isTTY, write: (text: string) => { output.push(text); } } }) as never;
    for (const [env, stdin, extra] of [[{ ...person.env, CLAUDECODE: '1' }, TTY, []], [{ ...person.env, CI: 'true' }, TTY, []], [person.env, PIPE, []], [{ TERM: 'dumb' }, TTY, []],
      [person.env, TTY, ['--json']]] as const)
      expect(await refusal(recoveryCommand(['recovery', 'review', '--scope', 's', ...extra], ctx(env, stdin)))).toMatchObject({ code: 'APPROVAL_INTERACTIVE_REQUIRED' });
    expect(calls).toEqual([]);
    await policyRecoveryCommand(['policy', 'recovery', '--scope', 's'], ctx(person.env, PIPE));
    expect(calls).toEqual(['inspect']); // a pipe reads the card; it never changes a row
  });
});
