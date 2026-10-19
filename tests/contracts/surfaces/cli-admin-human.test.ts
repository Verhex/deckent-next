import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearConfigCache, ErrorRegistry, inspectProductPaths, resolveGlobalConfigPaths } from '#platform/index.js';
import { registerProviderConfig } from '#adapters/index.js';
import { main } from '#surfaces/index.js';
import { backupCommand, toolchainsCommand, type BackupSetsView } from '#surfaces/core/cli-admin/index.js';
import type { CliCardRequest } from '#surfaces/core/cli-human/index.js';

registerProviderConfig(); // the `terminal` section (terminal.scopeId) is registered by the composed entry

/*
 * C-ADMIN (alpha.48, owner CLI review 2026-10-19): pool, backup, secret, audit, runtime, toolchains, paths in human words. A person's card is
 * simulated here (the Ink view is PTY-proven separately); every other caller goes through the real mode decision and the real card gate.
 */
const card = vi.hoisted(() => ({ interactive: false, answers: [] as (string | null)[], asked: [] as CliCardRequest[] }));
vi.mock('#surfaces/core/cli-human/index.js', async importOriginal => {
  const real = await importOriginal<typeof import('#surfaces/core/cli-human/index.js')>();
  return { ...real,
    cliMode: (context: Parameters<typeof real.cliMode>[0], json?: boolean) => card.interactive && !json ? { mode: 'interactive' as const, reason: 'tty' as const } : real.cliMode(context, json),
    askCliCard: async (request: CliCardRequest, io: Parameters<typeof real.askCliCard>[1]) => {
      if (!card.interactive) return real.askCliCard(request, io);
      card.asked.push(request); return card.answers.length ? card.answers.shift()! : null;
    } };
});
const CANARY = 'synthetic-canary-c4d1a9-not-a-real-value';
const roots: string[] = [];
beforeEach(() => { card.interactive = false; card.answers = []; card.asked = []; });
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function project(config: Record<string, unknown> = { terminal: { scopeId: 'live' } }, language = 'en') {
  const base = await mkdtemp(join(tmpdir(), 'deckent-cli-admin-')); roots.push(base);
  const home = join(base, 'home'), root = join(base, 'project');
  await mkdir(join(root, '.deckent'), { recursive: true, mode: 0o700 }); await mkdir(home, { mode: 0o700 });
  await writeFile(join(root, '.deckent', 'config.json'), JSON.stringify(config), { mode: 0o600 });
  const env = { HOME: home, USERPROFILE: home, PATH: process.env['PATH'] ?? '/usr/bin:/bin', DECKENT_LANGUAGE: language, NO_COLOR: '1' };
  return { root, env, home };
}
const capture = () => { const lines: string[] = []; return { text: () => lines.join(''), sink: { write: (text: string) => { lines.push(String(text)); return true; } } }; };
const piped = (text: string) => Object.assign(Readable.from([Buffer.from(text)]), { isTTY: false });
const scopes = { configChoiceSources: () => ({ list: async () => [{ value: 'live' }, { value: 'other' }] }) };
const io = (f: Awaited<ReturnType<typeof project>>, extra: Record<string, unknown> = {}) => {
  const out = capture(), err = capture();
  return { out, err, context: { root: f.root, env: f.env, stdin: piped(''), stdout: out.sink, stderr: err.sink, ...scopes, ...extra } };
};

// ---- pool -------------------------------------------------------------------------------------------------------------------------------
const poolView = (state: 'open' | 'held' = 'open') => ({ schemaVersion: 1 as const, poolId: 'admission', state, occupancy: { execution: 1, inFlight: 3 },
  hold: state === 'held' ? { schemaVersion: 1, poolId: 'admission', state, revision: 2, changedBy: { issuer: 'os', subject: '1000' }, changedAtMs: Date.now() - 7_200_000,
    scopeId: 'live', commandId: 'c', reason: 'Maintenance' } : null, drained: false });
const capacityView = { schemaVersion: 1 as const, scopeId: 'live', poolId: 'admission', capacity: { executionSlots: 4, inFlightSlots: 4 }, receipt: null };
function poolHandlers(calls: unknown[]) {
  return { inspectPoolHold: async () => poolView(), inspectPoolCapacity: async () => capacityView,
    applyPoolHold: async (_root: string, command: { scopeId: string; poolId?: string; action: string; reason?: string }) => { calls.push(command);
      return { schemaVersion: 1, scopeId: command.scopeId, commandId: 'c', poolId: 'admission', action: command.action, changed: true, state: command.action === 'hold' ? 'held' : 'open', hold: null }; },
    applyPoolCapacity: async (_root: string, command: { scopeId: string; capacity: { executionSlots: number; inFlightSlots: number } }) => { calls.push(command);
      return { schemaVersion: 1, scopeId: command.scopeId, commandId: 'c', poolId: 'admission', actor: { issuer: 'os', subject: '1000' }, atMs: 1, changed: true,
        previous: { executionSlots: 4, inFlightSlots: 4 }, next: command.capacity }; },
    releaseQuota: async (_root: string, command: { scopeId: string; channelId: string }) => { calls.push(command); return { schemaVersion: 1, channelId: command.channelId, released: 2 }; } };
}

it.each([['en', 'Pool admission · open', 'Now: 1 running, 2 being evaluated', 'Capacity: at most 4 jobs at the same time', 'scope: live (default)'],
  ['tr', 'Havuz admission · açık', 'Şu an: 1 çalışan, 2 değerlendirmede', 'Kapasite: aynı anda en çok 4 iş', 'scope: live (varsayılan)']] as const)(
  'pool status (%s): the configured scope is named, the state is in human words and empty fields are left out', async (language, open, now, capacity, notice) => {
  const f = await project(undefined, language), calls: unknown[] = [], { out, context } = io(f, poolHandlers(calls));
  expect(await main(['pool'], context)).toBe(0);
  expect(out.text()).toContain(notice); expect(out.text()).toContain(open); expect(out.text()).toContain(now); expect(out.text()).toContain(capacity);
  expect(out.text()).not.toMatch(/revision|drained|by - | - |\{/u);
  const json = io(f, poolHandlers(calls));
  expect(await main(['pool', 'status', '--json'], json.context)).toBe(0);
  expect(JSON.parse(json.out.text())).toMatchObject({ poolId: 'admission', state: 'open', capacity: { capacity: { executionSlots: 4 } } });
});

it('pool changes off a terminal need --scope (owner-accepted change): CLI_SCOPE_REQUIRED, exit 2, nothing written; an explicit scope is never asked', async () => {
  const f = await project(), calls: unknown[] = [];
  for (const argv of [['pool', 'hold'], ['pool', 'resume'], ['pool', 'set-capacity', '--execution-slots', '2', '--in-flight-slots', '2'], ['pool', 'quota-release', '--channel', 'c']]) {
    const { err, context } = io(f, poolHandlers(calls));
    expect(await main(argv, context), argv.join(' ')).toBe(2);
    expect(err.text()).toContain('CLI_SCOPE_REQUIRED'); expect(err.text()).toContain('live, other');
  }
  expect(calls).toEqual([]);
  const { context } = io(f, poolHandlers(calls));
  expect(await main(['pool', 'hold', '--scope', 'live', '--reason', 'deploy', '--json'], context)).toBe(0);
  expect(calls).toEqual([expect.objectContaining({ scopeId: 'live', action: 'hold', reason: 'deploy' })]);
});

it('pool hold on a terminal: scope picker, then the reason by selection, then what / which pool / why; cancel writes nothing', async () => {
  const f = await project(), calls: unknown[] = [];
  card.interactive = true; card.answers = ['live', 'maintenance', 'cancel'];
  const cancelled = io(f, poolHandlers(calls));
  expect(await main(['pool', 'hold'], cancelled.context)).toBe(1);
  expect(calls).toEqual([]); expect(cancelled.err.text()).toContain('Cancelled; nothing was changed.');
  expect(card.asked[0]).toMatchObject({ initial: 'live' }); // the configured default is preselected, never taken silently
  expect(card.asked[2]!.body).toEqual(['Scope live · pool the installation\'s admission pool', 'No new work starts in this pool; work already running finishes.', 'Reason: Maintenance']);
  card.answers = ['live', 'maintenance', 'apply'];
  expect(await main(['pool', 'hold'], io(f, poolHandlers(calls)).context)).toBe(0);
  expect(calls).toEqual([expect.objectContaining({ scopeId: 'live', action: 'hold', reason: 'pool-hold:maintenance' })]); // the fixed id, not the sentence
  card.answers = ['live', '2', 'apply']; calls.length = 0;
  expect(await main(['pool', 'set-capacity'], io(f, poolHandlers(calls)).context)).toBe(0);
  expect(calls).toEqual([expect.objectContaining({ capacity: { executionSlots: 2, inFlightSlots: 4 } })]);
  expect(card.asked.at(-2)!.options.map(option => option.id)).toContain('4');
});

it('lead 2026-10-19: a TR and an EN session record the same language-neutral reason id; every reader renders it in its own language', async () => {
  const recorded: unknown[] = [];
  for (const language of ['tr', 'en']) {
    const f = await project(undefined, language), calls: unknown[] = [];
    card.interactive = true; card.answers = ['live', 'problem', 'apply'];
    expect(await main(['pool', 'hold'], io(f, poolHandlers(calls)).context)).toBe(0);
    recorded.push((calls[0] as { reason?: string }).reason);
  }
  expect(recorded).toEqual(['pool-hold:problem', 'pool-hold:problem']);
  card.interactive = false;
  const held = (reason: string) => ({ ...poolHandlers([]), inspectPoolHold: async () => ({ ...poolView('held'), hold: { ...poolView('held').hold!, reason } }) });
  for (const [language, text] of [['en', 'Reason: Investigating a problem'], ['tr', 'Neden: Bir sorun inceleniyor']] as const) {
    const f = await project(undefined, language), view = io(f, held('pool-hold:problem'));
    expect(await main(['pool'], view.context)).toBe(0); expect(view.out.text()).toContain(text); expect(view.out.text()).not.toContain('pool-hold:');
  }
  // A caller's own --reason text is shown verbatim and terminal-safe; an unknown id is never translated.
  const f = await project(), own = io(f, held('deploy \u001b[31mwindow'));
  expect(await main(['pool'], own.context)).toBe(0); expect(own.out.text()).toContain('Reason: deploy'); expect(own.out.text()).not.toContain('\u001b');
});

// ---- backup -----------------------------------------------------------------------------------------------------------------------------
const sets = (directory: string): BackupSetsView => ({ schemaVersion: 1, directory, schedule: 'before-upgrade', retention: 7, passphraseStored: true, sets: [
  { path: join(directory, 'recovery-2026-10-15T10-00-00Z-00000000-0000-4000-8000-000000000001'), name: 'recovery-2026-10-15T10-00-00Z-00000000-0000-4000-8000-000000000001',
    kind: 'scheduled', createdAtMs: Date.parse('2026-10-15T10:00:00Z'), bytes: 12_582_912, lastVerifiedAtMs: Date.now() - 2 * 86_400_000 },
  { path: join(directory, 'manual-set'), name: 'manual-set', kind: 'manual', createdAtMs: Date.parse('2026-10-09T08:00:00Z'), bytes: 900, lastVerifiedAtMs: null }] });

it('bare backup lists the sets: schedule and retention first, the passphrase warning, then date · size · kind · last verified · name', async () => {
  const f = await project(), { out, context } = io(f, { inspectBackupSets: async () => sets('/srv/backups/recovery') });
  await backupCommand(['backup'], context);
  const text = out.text();
  expect(text).toContain('Recovery sets in /srv/backups/recovery'); expect(text).toContain('Schedule: before each upgrade · keeps the newest 7 scheduled sets');
  expect(text).toContain('The backup passphrase is stored inside this installation; keep a copy off this machine as well.');
  expect(text).toMatch(/Date\s+Size\s+Kind\s+Last verified\s+Name/u); expect(text).toMatch(/12(\.0)? MB\s+automatic\s+2 d ago/u); expect(text).toMatch(/by hand\s+not on record\s+manual-set/u);
  expect(text.indexOf('recovery-2026-10-15')).toBeLessThan(text.indexOf('manual-set'));
  // The assurance-gated passphrase read refused or failed: the line says unknown and the list still renders (fail-closed, no error).
  const unknown = io(f, { inspectBackupSets: async () => ({ ...sets('/srv/r'), passphraseStored: null }) });
  await backupCommand(['backup'], unknown.context);
  expect(unknown.out.text()).toContain('backup passphrase is stored inside this installation: unknown'); expect(unknown.out.text()).toContain('manual-set');
  expect(text).not.toContain('{');
  const view = sets('/srv/backups/recovery'), json = io(f, { inspectBackupSets: async () => view }); // one view: its times come from Date.now()
  await backupCommand(['backup', '--json'], json.context);
  expect(JSON.parse(json.out.text())).toEqual(view);
});

it('backup verify/restore without --set off a terminal: BACKUP_SET_REQUIRED (exit 2) naming the listed sets; nothing runs, no passphrase is read', async () => {
  const f = await project(), executed: unknown[] = [];
  for (const action of ['verify', 'restore']) {
    const { err, context } = io(f, { inspectBackupSets: async () => sets('/srv/r'), executeBackup: async (...args: unknown[]) => { executed.push(args); throw new Error('unreachable'); } });
    expect(await main(['backup', action, '--scope', 'live', '--target', '/srv/t'].slice(0, action === 'verify' ? 4 : 6), context), action).toBe(2);
    expect(err.text()).toContain('BACKUP_SET_REQUIRED'); expect(err.text()).toContain('/srv/r/manual-set');
  }
  expect(executed).toEqual([]);
});

it('a terminal that cannot hide typing is its own cause (C-PRIO finding), never "wrong passphrase"; a backup change takes no silent scope', async () => {
  const f = await project(), executed: unknown[] = [];
  const handlers = { executeBackup: async (...args: unknown[]) => { executed.push(args); throw new Error('unreachable'); } };
  const tty = io(f, { ...handlers, stdin: Object.assign(Readable.from([]), { isTTY: true }) });
  expect(await main(['backup', 'verify', '--set', '/srv/set'], tty.context)).toBe(78);
  expect(tty.err.text()).toContain('BACKUP_PASSPHRASE_PROMPT_UNAVAILABLE'); expect(tty.err.text()).not.toContain('BACKUP_PASSPHRASE_INVALID');
  const create = io(f, handlers);
  expect(await main(['backup', 'create', '--set', '/srv/new'], create.context)).toBe(2);
  expect(create.err.text()).toContain('CLI_SCOPE_REQUIRED');
  expect(executed).toEqual([]);
});

it('backup restore on a terminal: a running service is refused before the passphrase; otherwise the card shows set, target, service and kept files', async () => {
  const f = await project(), executed: { command: Record<string, unknown>; passphrase: string }[] = [];
  const handlers = (running: boolean) => ({ inspectBackupSets: async () => sets('/srv/r'),
    describeRuntimeService: async () => { if (running) return {}; throw ErrorRegistry.createError('LOCAL_RUNTIME_UNAVAILABLE'); },
    executeBackup: async (_root: string, command: Record<string, unknown>, passphrase: string) => { executed.push({ command, passphrase });
      return { schemaVersion: 1, action: 'restore', set: String(command['set']), ledgerDigest: 'd', files: 3, createdAt: '2026-10-15T10:00:00.000Z', relocation: null, globalConfig: null,
        preserved: ['/p/.deckent/policy.json.damaged-1'] }; } });
  card.interactive = true; card.answers = ['live', '/srv/r/manual-set'];
  const running = io(f, { ...handlers(true), stdin: piped(`${CANARY}\n`) });
  expect(await main(['backup', 'restore'], running.context)).toBe(78);
  expect(running.err.text()).toContain('BACKUP_SERVICE_RUNNING'); expect(executed).toEqual([]);
  card.answers = ['live', '/srv/r/manual-set', 'apply']; card.asked = [];
  const stopped = io(f, { ...handlers(false), stdin: piped(`${CANARY}\n`) });
  expect(await main(['backup', 'restore'], stopped.context)).toBe(0);
  expect(card.asked[2]!.body).toEqual(['Set: /srv/r/manual-set', `Target project: ${resolve(f.root)}`, expect.stringContaining('stopped'), expect.stringContaining('.damaged-')]);
  expect(executed).toEqual([{ command: expect.objectContaining({ action: 'restore', set: '/srv/r/manual-set', target: resolve(f.root), confirmTarget: resolve(f.root), scopeId: 'live' }), passphrase: CANARY }]);
  expect(stopped.out.text()).toContain('Replaced files kept next to them: /p/.deckent/policy.json.damaged-1');
  expect(stopped.out.text() + stopped.err.text()).not.toContain(CANARY);
});

// ---- secret -----------------------------------------------------------------------------------------------------------------------------
async function withGlobal(f: Awaited<ReturnType<typeof project>>, document: Record<string, unknown>) {
  const path = resolveGlobalConfigPaths(f.env).platformPath;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await chmod(dirname(path), 0o700);
  await writeFile(path, JSON.stringify(document), { mode: 0o600 }); clearConfigCache();
}
function secretHandlers(calls: unknown[], names = ['DECKENT_OPENAI_KEY', 'UNUSED_KEY']) {
  return { listSecretNames: async () => ({ schemaVersion: 1 as const, backend: 'core.secret-store.encrypted-file@1', names }),
    setSecret: async (_root: string, input: { scopeId: string; name: string; value: string }) => { calls.push(input);
      return { schemaVersion: 1 as const, scopeId: input.scopeId, name: input.name, action: 'set' as const, backend: 'core.secret-store.encrypted-file@1', removed: null }; },
    deleteSecret: async (_root: string, input: { scopeId: string; name: string }) => { calls.push(input);
      return { schemaVersion: 1 as const, scopeId: input.scopeId, name: input.name, action: 'delete' as const, backend: 'core.secret-store.encrypted-file@1', removed: true }; },
    listSecretStores: async () => ({ schemaVersion: 1 as const, current: 'core.secret-store.encrypted-file@1', stores: ['core.secret-store.env@1', 'core.secret-store.file@1', 'core.secret-store.encrypted-file@1'] }),
    switchSecretStore: async (_root: string, input: { scopeId: string; to: string; confirmDowngrade: boolean }) => { calls.push(input);
      return { schemaVersion: 1 as const, scopeId: input.scopeId, status: 'switched' as const, from: 'core.secret-store.encrypted-file@1', to: input.to, entries: 2, downgrade: true, cleaned: true }; } };
}

it('secret list: name · used by · store, a referenced key the store lacks shows as missing; never a value', async () => {
  const f = await project(); await withGlobal(f, { probe: { token: '$DECK:DECKENT_OPENAI_KEY', other: '$DECK:MISSING_KEY' } });
  const calls: unknown[] = [], { out, context } = io(f, secretHandlers(calls));
  expect(await main(['secret'], context)).toBe(0);
  const text = out.text();
  expect(text).toContain('2 stored. Values are never shown.'); expect(text).toMatch(/Name\s+Used by\s+Store/u);
  expect(text).toMatch(/DECKENT_OPENAI_KEY\s+config probe\.token\s+encrypted file/u); expect(text).toMatch(/MISSING_KEY\s+config probe\.other\s+missing — deckent secret set MISSING_KEY/u);
  expect(text).toMatch(/UNUSED_KEY\s+not referenced/u); expect(text).not.toContain('{');
});

it('off a terminal: secret set is refused before stdin is read (SEC-1 note), delete needs --scope; on a terminal set offers the missing names and delete shows the users', async () => {
  const f = await project(); await withGlobal(f, { probe: { token: '$DECK:DECKENT_OPENAI_KEY', other: '$DECK:MISSING_KEY' } });
  const calls: unknown[] = [];
  const pipe = io(f, { ...secretHandlers(calls), stdin: piped(CANARY) });
  expect(await main(['secret', 'set', 'MISSING_KEY', '--scope', 'live'], pipe.context)).toBe(1);
  expect(pipe.err.text()).toContain('SECRET_SET_TERMINAL_REQUIRED'); expect((pipe.context.stdin as Readable).readableEnded).toBe(false);
  const del = io(f, secretHandlers(calls));
  expect(await main(['secret', 'delete', 'DECKENT_OPENAI_KEY'], del.context)).toBe(2);
  expect(del.err.text()).toContain('CLI_SCOPE_REQUIRED'); expect(calls).toEqual([]);
  card.interactive = true; card.answers = ['MISSING_KEY', 'live'];
  const set = io(f, { ...secretHandlers(calls), stdin: piped(`${CANARY}\n`) });
  expect(await main(['secret', 'set'], set.context)).toBe(0);
  expect(card.asked[0]!.options.map(option => option.id)).toEqual(['MISSING_KEY']);
  expect(calls).toEqual([{ schemaVersion: 1, scopeId: 'live', name: 'MISSING_KEY', value: CANARY }]);
  expect(set.out.text()).toContain('MISSING_KEY saved in store: encrypted file.'); expect(set.out.text() + set.err.text()).not.toContain(CANARY);
  card.answers = ['live', 'cancel']; card.asked = [];
  expect(await main(['secret', 'delete', 'DECKENT_OPENAI_KEY'], io(f, secretHandlers(calls)).context)).toBe(1);
  expect(card.asked[1]!.body).toEqual(['Still used by: config probe.token. They stop working until it is set again.']);
  expect(calls).toHaveLength(1);
});

it('secret store: bare off a terminal explains the stores; on a terminal a weaker store needs the separate warning card, else nothing moves', async () => {
  const f = await project(), calls: unknown[] = [];
  const bare = io(f, secretHandlers(calls));
  expect(await main(['secret', 'store'], bare.context)).toBe(0);
  expect(bare.out.text()).toContain('Current store: encrypted file (core.secret-store.encrypted-file@1)');
  expect(bare.out.text()).toContain('plain file — plain text on disk, readable only by you; less safe');
  card.interactive = true; card.answers = ['core.secret-store.file@1', 'cancel'];
  const refused = io(f, secretHandlers(calls));
  expect(await main(['secret', 'store'], refused.context)).not.toBe(0);
  expect(refused.err.text()).toContain('SECRET_STORE_DOWNGRADE_UNCONFIRMED'); expect(calls).toEqual([]);
  expect(card.asked[1]).toMatchObject({ title: 'Lower the protection of your keys?' });
  card.answers = ['core.secret-store.file@1', 'apply', 'live'];
  expect(await main(['secret', 'store'], io(f, secretHandlers(calls)).context)).toBe(0);
  expect(calls).toEqual([expect.objectContaining({ scopeId: 'live', to: 'core.secret-store.file@1', confirmDowngrade: true })]);
});

// ---- audit ------------------------------------------------------------------------------------------------------------------------------
const witness = (atMs: number) => ({ schemaVersion: 1 as const, kind: 'deckent-audit-checkpoint' as const, digest: 'a'.repeat(64), checkpoint: { schemaVersion: 1 as const,
  installationId: 'i', scopeId: 'live', sequence: 36, atMs, head: { sequence: 2553, digest: 'b'.repeat(64) }, policyDigest: 'c'.repeat(64), producersDigest: 'd'.repeat(64),
  previousDigest: null, keyId: 'k', mac: 'e'.repeat(64) } });
const verification = () => ({ schemaVersion: 1 as const, scopeId: 'live', status: 'match' as const, reason: 'verified' as const, head: { sequence: 2553, digest: 'b'.repeat(64) },
  checkpoint: witness(Date.now() - 2 * 86_400_000) });

it('bare audit verifies, says when the last checkpoint was made and what this check cannot do; --export-checkpoint <file> writes 0600 once', async () => {
  const f = await project(), handlers = { verifyAudit: async () => verification() };
  const bare = io(f, handlers);
  expect(await main(['audit'], bare.context)).toBe(0);
  expect(bare.out.text()).toContain('Last checkpoint: 2 d ago (sequence 36)'); expect(bare.out.text()).toContain('it does not prevent one');
  const file = join(f.root, 'witness.json'), saved = io(f, handlers);
  expect(await main(['audit', 'verify', '--export-checkpoint', file], saved.context)).toBe(0);
  expect(saved.out.text()).toContain(`Checkpoint 36 saved: ${file}`);
  expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ kind: 'deckent-audit-checkpoint', checkpoint: { sequence: 36 } });
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  const before = await readFile(file, 'utf8'), again = io(f, handlers);
  expect(await main(['audit', 'verify', '--export-checkpoint', file], again.context)).toBe(2);
  expect(again.err.text()).toContain('AUDIT_CHECKPOINT_EXPORT_EXISTS'); expect(await readFile(file, 'utf8')).toBe(before);
  const stdout = io(f, handlers);
  expect(await main(['audit', 'verify', '--export-checkpoint'], stdout.context)).toBe(0);
  expect(JSON.parse(stdout.out.text())).toMatchObject({ checkpoint: { sequence: 36 } });
});

it('audit rebaseline asks only a person on a terminal card; any other caller is refused before anything is written', async () => {
  const f = await project(); let written = 0;
  const handlers = { rebaselineAudit: async (_root: string, _input: unknown, _options: unknown, confirm: (current: never) => Promise<boolean>) => {
    const ok = await confirm({ ...verification(), policyDigest: 'c'.repeat(64), producersDigest: 'd'.repeat(64) } as never);
    if (!ok) return null; written++; return verification(); } };
  const agent = io(f, { ...handlers, env: { ...f.env, CLAUDECODE: '1' } });
  expect(await main(['audit', 'rebaseline', '--reason', 'policy reviewed'], agent.context)).not.toBe(0);
  expect(agent.err.text()).toContain('TERMINAL_TTY_REQUIRED'); expect(written).toBe(0);
  card.interactive = true; card.answers = ['cancel'];
  expect(await main(['audit', 'rebaseline', '--reason', 'policy reviewed'], io(f, handlers).context)).toBe(1);
  expect(card.asked[0]).toMatchObject({ title: 'Re-baseline audit checkpoints for scope live' }); expect(written).toBe(0);
});

// ---- runtime ----------------------------------------------------------------------------------------------------------------------------
const descriptor = { schemaVersion: 1 as const, instanceId: '9d934110-0000-4000-8000-000000000000', shutdownAvailable: true as const, identity: { scopeId: 'live', serviceId: 'local' },
  build: { sourceTreeSha256: 'b'.repeat(64), sourceCommit: 'c'.repeat(40) }, processId: 4242, autoStarted: true, idleStopMs: 600_000 };
const runtimeHandlers = (calls: unknown[]) => ({ describeRuntimeService: async () => descriptor, inspectPoolHold: async () => poolView(),
  inspectAdminPaths: async () => ({ schemaVersion: 1 as const, runtimeSocket: '/tmp/dk-1000-x/s', mcp: null, secretStore: { store: 'core.secret-store.env@1', files: [] } }),
  stopRuntimeService: async (_root: string, _options: unknown, reason?: string) => { calls.push(reason);
    return { command: { schemaVersion: 1, commandId: 'c', serviceId: 'local', instanceId: descriptor.instanceId, reason: reason ?? '' }, result: { schemaVersion: 1 } }; },
  restartRuntimeService: async () => { calls.push('restart'); return { mode: 'started', instanceId: descriptor.instanceId, pid: 1 }; } });

it('bare runtime: build, configuration, running work and socket from what v29 carries (A48-D8: no start time, no uptime, no new field)', async () => {
  const f = await project(), calls: unknown[] = [];
  const bare = io(f, runtimeHandlers(calls));
  expect(await main(['runtime'], bare.context)).toBe(0);
  const text = bare.out.text();
  expect(text).toContain('Runtime service: running · build cccccccccccc'); expect(text).toContain('Configuration: cannot tell');
  expect(text).toContain('Now: 1 running, 2 being evaluated (scope live)'); expect(text).toContain('Socket: /tmp/dk-1000-x/s');
  expect(text).toContain('Service local · instance 9d934110 · started automatically by a terminal'); expect(text).toMatch(/Stops by itself after/u);
  expect(text).not.toMatch(/startedAt|uptime|Uptime|\{/u);
  const json = io(f, runtimeHandlers(calls));
  expect(await main(['runtime', 'describe', '--json'], json.context)).toBe(0);
  expect(JSON.parse(json.out.text())).toEqual(descriptor);
  const stopped = io(f, { ...runtimeHandlers(calls), describeRuntimeService: async () => { throw ErrorRegistry.createError('LOCAL_RUNTIME_UNAVAILABLE'); } });
  expect(await main(['runtime'], stopped.context)).toBe(0); // a stopped service is a successful status read (lead 2026-10-19)
  expect(stopped.out.text()).toContain('Runtime service: not running.'); expect(stopped.out.text()).toContain('Socket (not present now): /tmp/dk-1000-x/s');
  const stoppedJson = io(f, { ...runtimeHandlers(calls), describeRuntimeService: async () => { throw ErrorRegistry.createError('LOCAL_RUNTIME_UNAVAILABLE'); } });
  expect(await main(['runtime', 'describe', '--json'], stoppedJson.context)).not.toBe(0);
  expect(stoppedJson.err.text()).toContain('LOCAL_RUNTIME_UNAVAILABLE');
});

it('runtime shutdown: any caller off a terminal names its reason (audited); a person confirms on a card showing the affected work', async () => {
  const f = await project(), calls: unknown[] = [];
  const noReason = io(f, runtimeHandlers(calls));
  expect(await main(['runtime', 'shutdown'], noReason.context)).toBe(2);
  expect(noReason.err.text()).toContain('RUNTIME_SHUTDOWN_REASON_REQUIRED'); expect(calls).toEqual([]);
  expect(await main(['runtime', 'shutdown', '--reason', 'maintenance window'], io(f, runtimeHandlers(calls)).context)).toBe(0);
  expect(calls).toEqual(['maintenance window']);
  card.interactive = true; card.answers = ['cancel']; calls.length = 0;
  expect(await main(['runtime', 'shutdown'], io(f, runtimeHandlers(calls)).context)).toBe(1);
  expect(card.asked[0]!.body![0]).toBe('Affected work now: 1 running, 2 being evaluated (scope live)'); expect(calls).toEqual([]);
  card.answers = ['cancel'];
  expect(await main(['runtime', 'restart'], io(f, runtimeHandlers(calls)).context)).toBe(1); expect(calls).toEqual([]);
  card.answers = ['apply'];
  expect(await main(['runtime', 'shutdown'], io(f, runtimeHandlers(calls)).context)).toBe(0);
  expect(calls).toEqual(['Stopped from the terminal']);
});

// ---- toolchains -------------------------------------------------------------------------------------------------------------------------
const report = { schemaVersion: 1 as const, measuredAt: '2026-10-19T10:00:00.000Z', mode: 'report', registryEndpoint: 'https://registry.npmjs.org', basis: 'b', providers: [
  { provider: 'claude', mechanism: 'npm' as const, admitted: [{ profile: { id: 'p', version: 1 }, cliVersion: '2.1.302 (Claude Code)', version: '2.1.302' }],
    latest: { version: '2.1.303', source: 'npm', observedAt: '2026-10-19T10:00:00.000Z' }, status: 'stale' as const, update: 'u' },
  { provider: 'cursor', mechanism: 'installer-script' as const, admitted: [], latest: null, status: 'not-admitted' as const, update: 'u' }] };
const plan = { decision: 'planned', plan: { next: { imageVersion: 'r18-20261019' }, staleProviders: ['claude'], affectedProfiles: [{ provider: 'claude', cliVersion: '2.1.302' }] },
  build: null, proposalPath: null };

it('bare toolchains: the network use first, then tool · accepted · newest · state and whether updates run by themselves', async () => {
  const f = await project(), { out, context } = io(f, { inspectToolchainCurrency: async () => report });
  await toolchainsCommand(['toolchains'], context);
  const lines = out.text().split('\n');
  expect(lines[0]).toBe('Checks the newest versions over the network (https://registry.npmjs.org).');
  expect(out.text()).toMatch(/Tool\s+Accepted\s+Newest\s+State/u); expect(out.text()).toMatch(/claude\s+2\.1\.302\s+2\.1\.303\s+out of date/u);
  expect(out.text()).toMatch(/cursor\s+none\s+—\s+not in use/u); expect(out.text()).toContain('Out of date: claude 2.1.302 → 2.1.303');
  expect(out.text()).toContain('Automatic update: on'); expect(out.text()).not.toContain('{');
});

it('toolchains update off a terminal without --apply only reports; on a terminal the plan card decides, cancel builds nothing', async () => {
  const f = await project(), calls: boolean[] = [];
  const handlers = { updateToolchains: async (_root: string, input: { apply: boolean }) => { calls.push(input.apply); return input.apply ? { ...plan, decision: 'built', build: { imageId: 'sha256:x', tag: 'deckent-worker:r18' }, proposalPath: '/p.json' } : plan; } };
  const pipe = io(f, handlers);
  expect(await main(['toolchains', 'update'], pipe.context)).toBe(0);
  expect(calls).toEqual([false]); expect(pipe.out.text()).toContain('Planned: new worker image r18-20261019 for claude.'); expect(pipe.out.text()).toContain('Nothing was built.');
  card.interactive = true; card.answers = ['cancel']; calls.length = 0;
  expect(await main(['toolchains', 'update', '--apply'], io(f, handlers).context)).toBe(1);
  expect(calls).toEqual([false]);
  expect(card.asked[0]!.body).toEqual([expect.stringContaining('Updates: claude'), expect.stringContaining('Builds a Docker image; it may take up to 30 min 0 s'), expect.stringContaining('Running work keeps its current image')]);
  card.answers = ['apply']; calls.length = 0;
  const built = io(f, handlers);
  expect(await main(['toolchains', 'update'], built.context)).toBe(0);
  expect(calls).toEqual([false, true]); expect(built.out.text()).toContain('Built worker image r18-20261019 (deckent-worker:r18)');
});

// ---- paths ------------------------------------------------------------------------------------------------------------------------------
it('paths: grouped tables with exists/missing for a person, the unchanged layout inspection with --json', async () => {
  const f = await project();
  const human = io(f);
  expect(await main(['paths'], human.context)).toBe(0);
  const text = human.out.text();
  for (const heading of ['Configuration', 'Records and data', 'Security', 'Runtime', 'Terminal history and sessions', 'This user (outside the project)']) expect(text).toContain(`\n${heading}\n`);
  expect(text).toMatch(/installation configuration\s+\S+config\.json\s+exists/u); expect(text).toMatch(/ledger \(Runs, tasks, decisions\)\s+\S+ledger\.db\s+missing/u);
  expect(text).toContain('The socket the service really uses is shown by deckent doctor.'); expect(text).not.toContain('{');
  const json = io(f);
  expect(await main(['paths', '--json'], json.context)).toBe(0);
  expect(JSON.parse(json.out.text())).toEqual(JSON.parse(JSON.stringify(await inspectProductPaths(f.root, { env: f.env }))));
});
