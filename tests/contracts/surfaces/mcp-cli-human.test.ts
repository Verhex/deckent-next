import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { mcpDefinitionDigest, mcpRegistryPaths, mcpTrustDirectory, MCP_TRUST_FILE, runMcpCommand, updateMcpTrust,
  type McpCommandContext, type McpCommandRequest } from '#adapters/core/mcp-client/index.js';
import { DeckentError, resolveProductLayout } from '#platform/index.js';
import { main } from '#surfaces/index.js';
import type { CliCardRequest } from '#surfaces/core/cli-human/index.js';

// C-MODELS: the trust card is an arrow-key card on a person's terminal; it is simulated here and its lines are printed as the card shows them.
const shownCards = vi.hoisted(() => [] as string[]);
const cardAnswers = vi.hoisted(() => [] as (() => string | Promise<string>)[]);
vi.mock('#surfaces/core/cli-human/index.js', async importOriginal => {
  const real = await importOriginal<typeof import('#surfaces/core/cli-human/index.js')>();
  return { ...real, cliMode: () => ({ mode: 'interactive' as const, reason: 'tty' as const }),
    askCliCard: async (request: CliCardRequest) => { shownCards.push([request.title, ...(request.body ?? [])].join('\n')); return cardAnswers.shift()?.() ?? 'yes'; } };
});

const readFault = vi.hoisted(() => ({ current: null as { file: string; lock: string } | null }));
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, async readFile(path: Parameters<typeof fs.readFile>[0], options?: Parameters<typeof fs.readFile>[1]) {
    const fault = readFault.current;
    if (fault?.file === path && await fs.stat(fault.lock).then(() => true, () => false))
      throw Object.assign(new Error('Fixture registry read failed'), { code: 'EIO' });
    return fs.readFile(path, options);
  } };
});

const changedEN = 'The selected MCP server changed. Open the list and confirm the current server again.';
const changedTR = 'Seçtiğiniz MCP sunucusu değişti. Listeyi açıp güncel sunucuyu yeniden onaylayın.';
const unverifiedEN = 'The selected MCP server could not be verified. Check that the registry can be read, then reopen the list.';
const unverifiedTR = 'Seçtiğiniz MCP sunucusu doğrulanamadı. Kayıt dosyasının okunabildiğini kontrol edip listeyi yeniden açın.';

async function checkPickedWithdrawals() {
  const base = await mkdtemp(join(tmpdir(), 'deckent-mcp-confirm-')), root = join(base, 'project'), home = join(base, 'home');
  const env = { HOME: home, USERPROFILE: home, DECKENT_GLOBAL_HOME: join(home, '.deckent'), NO_COLOR: '1' };
  const registries = mcpRegistryPaths(root, env.DECKENT_GLOBAL_HOME);
  const entries = { user: { command: 'user-fixture' }, project: { command: 'project-fixture' } };
  const project = { mcpServers: { fx: entries.project } };
  const replacement = { mcpServers: { fx: { ...entries.project, timeoutMs: 5000 } } };
  const auditors: string[] = [], grants: string[] = [];
  const context: McpCommandContext = { projectRoot: root, layout: resolveProductLayout({ projectRoot: root }), environment: env, secret: async () => undefined,
    principal: { issuer: 'fixture', subject: 'owner' }, sandboxes: [], ask: async () => null, describeNotice: () => '',
    audit: async target => { auditors.push(target.scope); },
    grants: { grant: async () => ({ status: 'none' }), revoke: async target => { grants.push(target.scope); return { status: 'none' }; } } };
  const writeRegistry = (file: string, contents: unknown) => writeFile(file, JSON.stringify(contents), { mode: 0o600 });
  try {
    await mkdir(dirname(registries.project), { recursive: true });
    await mkdir(dirname(registries.personal), { recursive: true });
    await writeRegistry(registries.personal, { mcpServers: { fx: entries.user } });
    const trustFiles = await Promise.all((['user', 'project'] as const).map(async scope => {
      const directory = await mcpTrustDirectory(scope, context, true);
      await updateMcpTrust(directory, () => [{ name: 'fx', scope, definitionDigest: mcpDefinitionDigest('fx', entries[scope]), decision: 'trusted', tools: [],
        reconnect: 0, approvedAtMs: 1, principal: context.principal }]);
      return join(directory, MCP_TRUST_FILE);
    }));
    const readTrust = () => Promise.all(trustFiles.map(file => readFile(file, 'utf8')));
    const picked = async (verb: 'revoke' | 'remove', onConfirm?: () => void | Promise<void>) => {
      const before = await readTrust();
      const stderr: string[] = [];
      auditors.length = grants.length = 0;
      const projectScope = verb === 'remove';
      cardAnswers.push(() => projectScope ? 'project:fx' : 'user:fx');
      if (projectScope) cardAnswers.push(() => 'remove');
      cardAnswers.push(async () => { await onConfirm?.(); return 'apply'; });
      let localized: string | undefined;
      const code = await main(projectScope ? ['mcp', '--lang', 'en'] : ['mcp', 'revoke', '--lang', 'en'], {
        root, env, stdout: { write: () => true }, stderr: { write: (line: string) => stderr.push(line) },
        async runMcpCommand(_root: string, request: McpCommandRequest) {
          try { return await runMcpCommand(request, context); }
          catch (error) { if (error instanceof DeckentError) localized = error.localize?.('tr').message; throw error; }
        },
      } as never);
      readFault.current = null;
      shownCards.length = 0;
      return { code, localized, stderr: stderr.join('').trim(), auditors: [...auditors], grants: [...grants], before, after: await readTrust() };
    };
    const refuse = (result: Awaited<ReturnType<typeof picked>>, code: string, message: string) => {
      expect.soft(result.code).toBe(1);
      expect.soft(result.stderr).toBe(`Error: ${message} [${code}]`);
      expect.soft(result.after).toEqual(result.before);
      expect.soft([result.auditors, result.grants]).toEqual([[], []]);
    };
    const changedRevoke = await picked('revoke', () => writeRegistry(registries.project, project));
    refuse(changedRevoke, 'MCP_SERVER_CHANGED', changedEN);
    expect.soft(changedRevoke.localized).toBe(changedTR);
    const changedRemove = await picked('remove', () => writeRegistry(registries.project, replacement));
    refuse(changedRemove, 'MCP_SERVER_CHANGED', changedEN);
    const readRegistry = async () => JSON.parse(await readFile(registries.project, 'utf8')) as unknown;
    expect.soft(await readRegistry()).toEqual(replacement);

    await writeRegistry(registries.project, project);
    const blockedRead = (file: string, lockTarget: string) => () => {
      readFault.current = { file, lock: join(`${lockTarget}.write-lock`, 'owner.json') };
    };
    const unreadableRemove = await picked('remove', blockedRead(registries.project, registries.project));
    refuse(unreadableRemove, 'MCP_SERVER_UNVERIFIED', unverifiedEN);
    expect.soft(unreadableRemove.localized).toBe(unverifiedTR);
    expect.soft(await readRegistry()).toEqual(project);

    // One successful sequence proves that each operation touches only its selected scope.
    const removed = await picked('remove');
    expect(removed).toMatchObject({ code: 0, auditors: ['project'], grants: ['project'] });
    expect(await readRegistry()).toEqual({ mcpServers: {} });
    expect(removed.after[0]).toBe(removed.before[0]);
    expect(JSON.parse(removed.after[1]!).servers).toEqual([]);

    const unreadableRevoke = await picked('revoke', blockedRead(registries.personal, trustFiles[0]!));
    refuse(unreadableRevoke, 'MCP_SERVER_UNVERIFIED', unverifiedEN);
    const mismatched = await picked('revoke', () => updateMcpTrust(dirname(trustFiles[0]!), state =>
      state.servers.map(record => ({ ...record, definitionDigest: mcpDefinitionDigest('fx', entries.project) }))).then(() => undefined));
    expect.soft(mismatched.code).toBe(1);
    expect.soft(mismatched.stderr).toBe(`Error: ${changedEN} [MCP_SERVER_CHANGED]`);
    expect.soft([mismatched.auditors, mismatched.grants]).toEqual([[], []]);
    const previous = JSON.parse(mismatched.before[0]!);
    expect.soft(JSON.parse(mismatched.after[0]!)).toEqual({ ...previous, revision: previous.revision + 1,
      servers: [{ ...previous.servers[0], definitionDigest: mcpDefinitionDigest('fx', entries.project) }] });
    await writeFile(trustFiles[0]!, mismatched.before[0]!);

    const revoked = await picked('revoke');
    expect(revoked).toMatchObject({ code: 0, auditors: ['user'], grants: ['user'] });
    expect(JSON.parse(revoked.after[0]!).servers).toEqual([]);
    expect(revoked.after[1]).toBe(revoked.before[1]);
  } finally {
    readFault.current = null;
    cardAnswers.length = 0;
    shownCards.length = 0;
    await rm(base, { recursive: true, force: true });
  }
}

// T3 integration (L1 i18n debt): `deckent mcp add` prints its trust card with the terminal window's localized fields (realm in words, URL and
// header names, never a value) and the K1 grant outcome as one sentence — not the adapter's raw card object or a `grant: {…}` dump.
const card = { phase: 'launch', name: 'web', scope: 'local', file: '/p/.deckent/mcp.local.json', definitionDigest: 'a'.repeat(64), transport: 'http',
  command: 'https://mcp.example.com/mcp', args: [], variables: [], envNames: [], headerNames: ['Authorization'], realm: 'none',
  posture: 'remote: an HTTP server on another machine (nothing runs here; its headers go to that endpoint with every request)', note: null };
async function run(lang: 'en' | 'tr', grant: unknown) {
  const out: string[] = [], stdin = Object.assign(new PassThrough(), { isTTY: true });
  const code = await main(['mcp', 'add', '--transport', 'http', '--header', 'Authorization: Bearer $DECK:GH', 'web', 'https://mcp.example.com/mcp', '--lang', lang], {
    root: '/p', env: {}, stdin, stdout: { write(value: string) { out.push(value); } },
    async runMcpCommand(_root: string, _request: unknown, _options: unknown, ask: (card: unknown) => Promise<boolean>) {
      await ask(card);
      return { schemaVersion: 1, added: { name: 'web', scope: 'local', file: '/p/.deckent/mcp.local.json' }, trust: 'trusted', pinnedTools: 2, grant };
    } } as never);
  return { code, text: [...shownCards.splice(0), out.join('')].join('\n') };
}
it('prints the trust card in the person\'s words and the grant outcome as a sentence (EN, TR)', async () => {
  const en = await run('en', { status: 'granted' });
  expect(en.code).toBe(0);
  expect(en.text).toContain('Start the MCP server web to read its tools?');
  expect(en.text).toContain('URL: https://mcp.example.com/mcp');
  expect(en.text).toContain('Headers: Authorization');
  expect(en.text).toContain('remote: an HTTP server on another machine; nothing runs here');
  expect(en.text).not.toContain('$DECK');
  expect(en.text).toContain('Policy grant written: this server is yours to call; standard asks every call, and tools marked "always ask" ask in every mode; every call is audited.');
  expect(en.text).not.toMatch(/grant:\s*\{/u);
  const tr = await run('tr', { status: 'refused', reason: 'administer' });
  expect.soft(tr.code).toBe(1);
  expect(tr.text).toContain('Başlıklar: Authorization');
  expect(tr.text).toContain('Güvenildi ama politika izni yazılmadı: politikanız politika kurallarını değiştirmenize izin vermiyor');
  const trGranted = await run('tr', { status: 'granted' });
  expect(trGranted.text).toContain('Politika izni yazıldı: bu sunucuyu çağırabilirsiniz; standart mod her çağrıda, "her zaman sor" işaretli araçlar her modda sorar; her çağrı denetim kaydına yazılır.');
});

it('prints the two revoke outcomes in EN and TR and preserves the same JSON receipt', async () => {
  const receipt = { schemaVersion: 1, revoked: { name: 'fx', scope: 'local' }, grant: { status: 'refused', reason: 'AUTHORITY_WITNESS_REQUIRED' } };
  const revoke = async (locale: 'en' | 'tr', result: unknown, json = false) => {
    const out: string[] = [];
    const code = await main(['mcp', 'revoke', 'fx', '--lang', locale, ...(json ? ['--json'] : [])], {
      root: '/p', env: {}, stdout: { write(value: string) { out.push(value); } },
      async runMcpCommand(_root: string, request: unknown) { expect(request).toEqual({ verb: 'revoke', name: 'fx' }); return result; },
    } as never);
    expect.soft(code, JSON.stringify(result)).toBe((result as typeof receipt).grant?.status === 'refused' ? 1 : 0);
    return out.join('').trimEnd();
  };
  const enTrust = 'Trust for fx was revoked. Approve it again before starting the server.';
  const enWitness = `${enTrust}\nThis operation removed no policy grant. Removing one needs the grant owner's terminal.`;
  expect.soft(await revoke('en', receipt)).toBe(enWitness);
  expect.soft(await revoke('en', { ...receipt, grant: { status: 'refused', reason: 'APPROVAL_INTERACTIVE_REQUIRED' } })).toBe(enWitness);
  expect.soft(await revoke('tr', receipt)).toBe('fx için güven geri alındı. Sunucuyu başlatmadan önce yeniden onaylayın.\nBu işlem politika izni kaldırmadı. Kaldırma işlemi için izin sahibinin terminali gerekir.');
  const enJson = await revoke('en', receipt, true), trJson = await revoke('tr', receipt, true);
  expect(trJson).toBe(enJson);
  expect(JSON.parse(enJson)).toEqual(receipt);
  const trustOnly = { schemaVersion: 1, revoked: receipt.revoked };
  expect.soft(await revoke('en', trustOnly)).toBe(`${enTrust}\nNo policy grant removal was recorded.`);
  expect.soft(await revoke('tr', trustOnly)).toBe('fx için güven geri alındı. Sunucuyu başlatmadan önce yeniden onaylayın.\nPolitika izni kaldırma işlemi kaydedilmedi.');
  expect(JSON.parse(await revoke('en', trustOnly, true))).toEqual(trustOnly);
  expect.soft(await revoke('en', { ...receipt, grant: { status: 'revoked' } })).toBe(`${enTrust}\nPolicy grant removed: calls to this server follow your company policy again.`);
  expect.soft(await revoke('en', { ...receipt, grant: { status: 'refused', reason: 'delegation' } })).toBe(`${enTrust}\nThe policy grant could not be removed. Review the scope’s policy before trying again.`);
  expect(await revoke('en', { ...receipt, grant: { status: 'refused', reason: 'not-settled' } })).toBe(`${enTrust}\nThe policy grant could not be removed. Review the scope’s policy before trying again.`);

});

it('reports an unfinished requested trust step while retaining the registration receipt', async () => {
  const approve = { schemaVersion: 1, name: 'web', scope: 'local', pinnedTools: 0 };
  const grant = { status: 'refused', reason: 'administer' };
  const registered = (trust: string, scope = 'local') => ({ schemaVersion: 1, added: { name: 'web', scope, file: '/p/mcp.json' }, trust });
  const add = ['add', 'web', 'https://mcp.example.com/mcp'], addJson = ['add-json', 'web', '{"command":"fixture"}'];
  for (const [argv, receipt, expected] of [
    [['approve', 'web'], { ...approve, approved: false }, 1],
    [['approve', 'web'], { ...approve, approved: true }, 0],
    [['approve', 'web'], { ...approve, approved: true, pinnedTools: 1, grant }, 1],
    [add, { ...registered('declined'), pinnedTools: 0 }, 1],
    [addJson, { ...registered('unanswered'), pinnedTools: 0 }, 1],
    [addJson, registered('shadowed'), 1],
    [add, { ...registered('trusted'), pinnedTools: 1 }, 0],
    [add, { ...registered('trusted'), pinnedTools: 1, grant }, 1],
    [addJson, { ...registered('trusted'), pinnedTools: 1, grant }, 1],
    [['remove', 'web'], { schemaVersion: 1, removed: registered('trusted').added, grant: { status: 'refused', reason: 'AUTHORITY_WITNESS_REQUIRED' } }, 1],
    [['remove', 'web'], { schemaVersion: 1, removed: registered('trusted').added, grant: { status: 'revoked' } }, 0],
    [[...add, '--no-approve'], registered('pending'), 0],
    [[...addJson, '--scope', 'project'], registered('pending', 'project'), 0],
  ] as const) {
    const out: string[] = [];
    const code = await main(['mcp', ...argv, '--json'], {
      root: '/p', env: {}, stdout: { write(value: string) { out.push(value); } }, runMcpCommand: async () => receipt,
    } as never);
    expect.soft(code, argv.join(' ')).toBe(expected);
    expect(JSON.parse(out.join(''))).toEqual(receipt);
  }
  const out: string[] = [];
  const code = await main(['mcp', 'remove', 'web', '--lang', 'en'], {
    root: '/p', env: {}, stdout: { write(value: string) { out.push(value); } },
    runMcpCommand: async () => ({ removed: registered('trusted').added, grant: { status: 'refused', reason: 'AUTHORITY_WITNESS_REQUIRED' } }),
  } as never);
  expect.soft(code).toBe(1);
  expect(out.join('').trimEnd()).toBe("Removed web (local)\nThis operation removed no policy grant. Removing one needs the grant owner's terminal.");
  await checkPickedWithdrawals();
  for (const [argv, locale, receipt, expected] of [
    [['approve', 'web'], 'en', { ...approve, approved: false, grant: { status: 'revoked' } },
      'web (local) was not approved; nothing is trusted.\nPolicy grant removed: calls to this server follow your company policy again.'],
    [add, 'en', { ...registered('declined'), grant: { status: 'none' } },
      'Added web (local); you declined its trust, so it does not start.\nNo policy grant removal was recorded.'],
    [addJson, 'tr', { ...registered('unanswered'), grant: { status: 'refused', reason: 'AUTHORITY_WITNESS_REQUIRED' } },
      'web (yerel) eklendi. İlk kullanımda güven onayı ister. Hemen onaylamak için deckent mcp approve web komutunu çalıştırın.\nBu işlem politika izni kaldırmadı. Kaldırma işlemi için izin sahibinin terminali gerekir.'],
  ] as const) {
    out.length = 0;
    expect.soft(await main(['mcp', ...argv, '--lang', locale], {
      root: '/p', env: {}, stdout: { write(value: string) { out.push(value); } }, runMcpCommand: async () => receipt,
    } as never)).toBe(1);
    expect.soft(out.join('').trimEnd()).toBe(expected);
  }
});
