import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dispatch, main } from '#surfaces/core/cli/index.js';
import * as cliHuman from '#surfaces/core/cli-human/index.js';
import { ErrorRegistry, PACKAGE_VERSION, t } from '#platform/index.js';
import type { ProjectAttachmentCommand } from '#domain/index.js';

let temporary: string, root: string, globalRoot: string, env: NodeJS.ProcessEnv;
beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'deckent-help-locale-'));
  root = join(temporary, 'project'); globalRoot = join(temporary, 'global');
  await mkdir(join(root, '.deckent'), { recursive: true });
  await mkdir(globalRoot);
  env = { HOME: temporary, DECKENT_GLOBAL_HOME: globalRoot, LANG: 'en_US.UTF-8', NO_COLOR: '1' };
});
afterEach(async () => { await rm(temporary, { recursive: true, force: true }); });

async function config(language: string, global = false) {
  await writeFile(join(global ? globalRoot : join(root, '.deckent'), 'config.json'), JSON.stringify({ schema_version: 3, language }));
}
async function help(argv: readonly string[], language: 'en' | 'tr') {
  let output = '', errors = '', observedLocale = '';
  expect(await main(argv, { root, env,
    initialize: () => { throw new Error('Help must not initialize execution'); },
    onLocale: locale => { observedLocale = locale; },
    stdout: { write: text => { output += text; } }, stderr: { write: text => { errors += text; } },
  })).toBe(0);
  expect(errors).toBe(''); expect(observedLocale).toBe(language);
  const fixtures = new URL('../../fixtures/cli-help/', import.meta.url);
  const golden = argv[0] === 'run'
    ? (JSON.parse(await readFile(new URL(`commands-${language}.json`, fixtures), 'utf8')) as Record<string, string>)['run']
    : await readFile(new URL(`top-${language}.txt`, fixtures), 'utf8');
  expect(output).toBe(golden);
}

it.each([['-h'], ['--help'], ['run', '--help']])('uses the project Turkish config for %j', async (...argv) => {
  await config('tr'); await help(argv, 'tr');
});
it('uses global language when project language is absent', async () => {
  await config('tr', true); await help(['-h'], 'tr');
});
it('reads language before provider sections are registered', async () => {
  await writeFile(join(root, '.deckent', 'config.json'), JSON.stringify({ schema_version: 3, language: 'tr',
    provider_invocation_profiles: { schemaVersion: 1, profiles: [] }, operations: { catalog: [] },
  }));
  await help(['-h'], 'tr');
});
it('uses the system locale when config language is absent', async () => {
  env['LANG'] = 'tr_TR.UTF-8'; await help(['-h'], 'tr');
});
it('prefers project language over global language', async () => {
  await config('en', true); await config('tr'); await help(['run', '--help'], 'tr');
});
it('prefers explicit language over config and environment', async () => {
  await config('tr'); env['DECKENT_LANGUAGE'] = 'tr';
  await help(['-h', '--lang', 'en'], 'en');
});
it.each(['DECKENT_LANGUAGE', 'DECKENT_LANG'])('prefers %s over config', async key => {
  await config('tr'); env[key] = 'en'; await help(['run', '--help'], 'en');
});
it('prefers DECKENT_LANGUAGE over DECKENT_LANG', async () => {
  await config('tr'); env['DECKENT_LANGUAGE'] = 'en'; env['DECKENT_LANG'] = 'tr';
  await help(['-h'], 'en');
});
it.each(['{broken', '{"schema_version":3,"language":"invalid"}', '[]'])('silently falls back without healing invalid config %s', async text => {
  const path = join(root, '.deckent', 'config.json');
  await writeFile(path, text); await help(['-h'], 'en');
  expect(await readFile(path, 'utf8')).toBe(text);
  expect(await readdir(join(root, '.deckent'))).toEqual(['config.json']);
  expect(await readdir(globalRoot)).toEqual([]);
});
it('silently falls back from invalid global config', async () => {
  await writeFile(join(globalRoot, 'config.json'), '{broken'); await help(['run', '--help'], 'en');
  expect(await readFile(join(globalRoot, 'config.json'), 'utf8')).toBe('{broken');
  expect(await readdir(globalRoot)).toEqual(['config.json']);
});
it('uses the default with missing config and creates no files', async () => {
  await help(['-h'], 'en');
  expect(await readdir(join(root, '.deckent'))).toEqual([]);
  expect(await readdir(globalRoot)).toEqual([]);
});

it('F5: invalid input names only registered command words and uses config language before parsing', async () => {
  await config('tr');
  for (const argv of [['doctor', 'private-value'], ['init', 'private-value'], ['do', '--request']]) {
    let errors = '';
    const code = await main(argv, { root, env, initialize() {}, stdout: { write() {} }, stderr: { write: text => { errors += text; } } });
    expect(code).toBe(2);
    expect(errors).toContain(`deckent ${argv[0]}`);
    expect(errors).not.toContain('private-value');
    expect(errors).not.toContain('Reuse the command');
    expect(errors).toContain('için');
  }
});
it('ATTACHDOC: human previews give a complete apply command; JSON stays exact and missing flags are named before any effect', async () => {
  const plan = { schemaVersion: 1, status: 'preview', planDigest: 'a'.repeat(64) };
  const projectAttachment = vi.fn(async () => plan);
  const invoke = async (argv: string[]) => {
    let output = '', errors = '';
    const code = await main(['terminal', 'attach', ...argv], { root, env, projectAttachment,
      stdin: { isTTY: false } as NodeJS.ReadStream,
      stdout: { write: text => { output += text; } }, stderr: { write: text => { errors += text; } },
    });
    return { code, output, errors };
  };
  const commandIds = new Set<string>();
  for (const language of ['en', 'tr']) {
    await config(language);
    const preview = await invoke(['--scope', 'target', '--preview']);
    expect(preview.code, preview.errors).toBe(0);
    expect(preview.output).toContain(language === 'en' ? 'To apply, run this command.' : 'Uygulamak için bu komutu çalıştırın.');
    const command = preview.output.trimEnd().split('\n').at(-1)!;
    expect(command).toMatch(/^deckent terminal attach --scope target --apply --expect a{64} --command-id [a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    commandIds.add(command.split(' ').at(-1)!);
    const args = command.split(' ').slice(3);
    projectAttachment.mockClear();
    const refused = await invoke(args);
    expect(refused.errors).toContain('AUTHORITY_WITNESS_REQUIRED');
    expect(refused.errors).not.toContain('CLI_USAGE'); expect(projectAttachment).not.toHaveBeenCalled();
    for (const flag of ['--scope', '--expect', '--command-id']) {
      const missing = args.filter((_, index) => args[index] !== flag && args[index - 1] !== flag);
      const result = await invoke(missing);
      expect(result.code).toBe(2); expect(result.output).toBe('');
      expect(result.errors).toContain(`${language === 'en' ? 'Missing argument' : 'Eksik argüman'}: ${flag}.`);
      expect(projectAttachment).not.toHaveBeenCalled();
    }
    const invalid = await invoke(args.map(value => value === command.split(' ').at(-1) ? 'private-invalid-id' : value));
    expect(invalid.code).toBe(2); expect(invalid.errors).toContain('--command-id');
    expect(invalid.errors).not.toContain('private-invalid-id'); expect(projectAttachment).not.toHaveBeenCalled();
    const json = await invoke(['--scope', 'target', '--preview', '--json']);
    expect(json.code).toBe(0); expect(json.output).toBe(JSON.stringify(plan) + '\n');
    const registration = await invoke(['--register', '--scope', 'source', '--preview']);
    expect(registration.code).toBe(0);
    expect(registration.output.trimEnd().split('\n').at(-1)).toBe(`deckent terminal attach --register --scope source --apply --expect ${plan.planDigest}`);
    const quoted = await invoke(['--scope', "target's project", '--preview']);
    expect(quoted.output).toContain("--scope 'target'\\''s project' --apply");
  }
  expect(commandIds.size).toBe(2);
});
it('attachment confirmations name the selected action in EN/TR and never offer a write card to a pipe or agent', async () => {
  const projectId = '11111111-1111-4111-8111-111111111111', digest = 'a'.repeat(64);
  const cancelled = (language: 'en' | 'tr', scope: string) => language === 'en'
    ? `Connection cancelled. This step left the folder and its connection records unchanged. To see the connection plan again, run \`deckent terminal attach --scope ${scope} --preview\` in this folder. \`deckent init\` starts a new, separate installation here.\n`
    : `Bağlantı iptal edildi. Bu adımda klasör ve bağlantı kayıtları değişmedi. Bağlantı planını yeniden görmek için bu klasörde \`deckent terminal attach --scope ${scope} --preview\` çalıştırın. \`deckent init\` burada yeni ve ayrı bir kurulum başlatır.\n`;
  const maskedScope = 'token=demo';
  const lifecycleCancelled = { en: 'Cancelled; nothing was changed.\n', tr: 'Vazgeçildi; hiçbir şey değiştirilmedi.\n' };
  const cancelledWithOriginalScope = {
    en: 'Connection cancelled. This step left the folder and its connection records unchanged. To see the connection plan again, rerun the earlier preview in this folder with the original scope. `deckent init` starts a new, separate installation here.\n',
    tr: 'Bağlantı iptal edildi. Bu adımda klasör ve bağlantı kayıtları değişmedi. Bağlantı planını yeniden görmek için önceki önizlemeyi bu klasörde özgün kapsamla tekrar çalıştırın. `deckent init` burada yeni ve ayrı bir kurulum başlatır.\n',
  };
  const cases: readonly [string[], string, string][] = [
    [['--register', '--scope', 'source', '--expect', digest], 'Register this source installation?', 'Bu kaynak kurulum kaydedilsin mi?'],
    [['--scope', 'target', '--expect', digest, '--command-id', projectId], 'Connect this folder to the selected installation?', 'Bu klasör seçilen kuruluma bağlansın mı?'],
    [['--revoke', projectId], "Revoke this project's attachment?", 'Bu projenin kurulum bağı geri alınsın mı?'],
    [['--lease-revoke', projectId], 'Revoke model use for this project?', 'Bu projenin model kullanım izni geri alınsın mı?'],
    [['--detach', projectId], 'Detach this project?', 'Bu proje kurulumdan ayrılsın mı?'],
    [['--unregister'], 'Unregister this source installation?', 'Bu kaynak kurulumun kaydı kaldırılsın mı?'],
    [['--relocate', '--scope', 'source'], "Update this project or source's recorded location?", 'Bu proje veya kaynağın kayıtlı konumu güncellensin mi?'],
    [['--restore', projectId, '--expect', digest], "Restore this project's attachment?", 'Bu projenin kurulum bağı yeniden açılsın mı?'],
  ];
  const confirm = vi.spyOn(cliHuman, 'askCliCard').mockResolvedValue('no'), projectAttachment = vi.fn();
  try {
    for (const language of ['en', 'tr'] as const) {
      await config(language);
      for (const [args, en, tr] of cases) {
        confirm.mockClear(); let errors = '';
        const context = { root, env, projectAttachment, stdin: { isTTY: true } as NodeJS.ReadStream,
          stdout: { isTTY: true, write() {} }, stderr: { write: (text: string) => { errors += text; } } };
        const attach = args.includes('--command-id');
        // Owner decision 155: a cancelled card exits 1 and says so; the lifecycle actions reuse the shared cancellation sentence.
        expect.soft([await main(['terminal', 'attach', ...args, '--apply'], context), errors], `cancelled ${args[0]} (${language})`)
          .toEqual([1, attach ? cancelled(language, 'target') : lifecycleCancelled[language]]);
        expect(confirm).toHaveBeenCalledOnce();
        const card = confirm.mock.calls[0]![0];
        expect(card.title).toBe(language === 'en' ? en : tr); expect(card.initial).toBe('no');
        expect(card.body?.join('\n')).toContain(language === 'en' ? 'Scope / project:' : 'Kapsam / proje:');
        if (args.includes('--relocate')) expect(card.body?.join('\n')).toContain(language === 'en'
          ? "Update the project or source's recorded location; keep its identity" : 'Proje veya kaynağın kayıtlı konumunu güncelle; kimliğini koru');
        if (attach) {
          errors = '';
          const code = await main(['terminal', 'attach', '--scope', maskedScope, '--expect', digest, '--command-id', projectId, '--apply'], context);
          expect.soft([code, errors], `explicit attach with a masked scope (${language})`).toEqual([1, cancelledWithOriginalScope[language]]);
        }
        confirm.mockClear();
        for (const refused of [{ ...context, stdin: { isTTY: false } as NodeJS.ReadStream }, { ...context, env: { ...env, AI_AGENT: '1' } }]) {
          errors = '';
          expect(await main(['terminal', 'attach', ...args, '--apply'], refused)).toBe(1);
          expect(errors).toContain('AUTHORITY_WITNESS_REQUIRED'); expect(confirm).not.toHaveBeenCalled();
        }
      }
    }
    expect(projectAttachment).not.toHaveBeenCalled();

    const incomplete = ErrorRegistry.createError('PROJECT_ATTACHMENT_INCOMPLETE');
    const offer = (scopeId: string) => ({ kind: 'ready', scopeId, path: root, writeRoot: root,
      planDigest: digest, preparation: { digest, connections: [] } });
    projectAttachment.mockImplementation(async (_root: string, input: ProjectAttachmentCommand) => {
      if (input.action === 'offer') return offer(projectId);
      throw incomplete;
    });
    let errors = '', output = '';
    const context = { root, env, projectAttachment, stdin: { isTTY: true, pause: vi.fn() } as unknown as NodeJS.ReadStream,
      stdout: { isTTY: true, write: (text: string) => { output += text; } }, stderr: { write: (text: string) => { errors += text; } } };
    const bareContext = { ...context, completeTerminalChat: vi.fn(), configChoiceSources: () => ({
      list: async () => { throw ErrorRegistry.createError('CLI_INSTALLATION_MISSING'); },
    }) };
    for (const language of ['en', 'tr'] as const) {
      await config(language);
      errors = ''; projectAttachment.mockClear();
      expect.soft([await main([], bareContext), errors]).toEqual([1, cancelled(language, projectId)]);
      expect(projectAttachment.mock.calls.map(([, input]) => input.action)).toEqual(['offer']);
      errors = ''; projectAttachment.mockClear();
      projectAttachment.mockResolvedValueOnce(offer(maskedScope));
      expect.soft([await main([], bareContext), errors], `bare offer with a masked scope (${language})`).toEqual([1, cancelledWithOriginalScope[language]]);
      expect(projectAttachment.mock.calls.map(([, input]) => input.action)).toEqual(['offer']);
    }

    errors = '';
    confirm.mockResolvedValue('yes');
    const generic = 'Hata: Proje bağlantısı tamamlanmamış. Özgün komut kimliği ve önizleme özetiyle aynı attach komutunu sürdürün. [PROJECT_ATTACHMENT_INCOMPLETE]\n';
    const explicit = await main(['terminal', 'attach', ...cases[1]![0], '--apply'], context);
    expect.soft([explicit, errors]).toEqual([1, generic]);

    errors = ''; projectAttachment.mockResolvedValueOnce({ status: 'pending' });
    const pending = await main(['terminal', 'attach', ...cases[1]![0], '--apply'], context);
    expect.soft([pending, errors, output]).toEqual([1, generic, '']);

    for (const [action, args, en, tr] of [
      ['restore', cases[7]![0], 'The attachment restore is unfinished. Rerun the same `deckent terminal attach --restore` command with the original project ID and preview digest. If it is still blocked, ask an installation administrator for help.', 'Proje bağlantısını geri yükleme tamamlanmadı. Aynı `deckent terminal attach --restore` komutunu özgün proje kimliği ve önizleme özetiyle yeniden çalıştırın. İşlem hâlâ duruyorsa kurulum yöneticisinden yardım isteyin.'],
      ['relocate', cases[6]![0], 'The location update is unfinished. Rerun the same `deckent terminal attach --relocate` command from the same folder with the original scope. If it is still blocked, ask an installation administrator for help.', 'Kayıtlı konumu güncelleme tamamlanmadı. Aynı `deckent terminal attach --relocate` komutunu aynı klasörde özgün kapsamla yeniden çalıştırın. İşlem hâlâ duruyorsa kurulum yöneticisinden yardım isteyin.'],
    ] as const) {
      errors = '';
      const code = await main(['terminal', 'attach', ...args, '--apply'], context);
      expect.soft([code, errors]).toEqual([1, `Hata: ${tr} [PROJECT_ATTACHMENT_INCOMPLETE]\n`]);
      expect.soft(t(`setup.attachment.incomplete.${action}`, {}, 'en')).toBe(en);
    }

    errors = '';
    const preview = await main(['terminal', 'attach', '--scope', 'target', '--preview'], context);
    expect([preview, errors]).toEqual([78, generic]);

    errors = '';
    const bare = await main([], bareContext);
    expect.soft([bare, errors]).toEqual([1, `Hata: Proje bağlantısı tamamlanmadı. Güncel planı \`deckent terminal attach --scope ${projectId} --preview\` ile önizleyin. Klasörde zaten bekleyen veya etkin bir bağlantı varsa yeni önizlemenin uygulama komutu reddedilir. Bu durumda özgün attach komutuyla sürdürün veya kurulum yöneticisinden yardım isteyin. [PROJECT_ATTACHMENT_INCOMPLETE]\n`]);
    // The fatal renderer masks the composed message, so a scope it would alter is never offered as a command argument;
    // `Bearer` alone is unmasked, but the bearer-token pattern masks the word after it (`--preview`) in the composed sentence.
    for (const [language, unfinished] of [
      ['en', 'Error: The attachment did not complete. Preview the current plan again in this folder with the original scope. If the folder already has a pending or active connection, the apply command from a fresh preview will be refused. Resume with the original attach command or ask an installation administrator for help. [PROJECT_ATTACHMENT_INCOMPLETE]\n'],
      ['tr', 'Hata: Proje bağlantısı tamamlanmadı. Güncel planı bu klasörde özgün kapsamla yeniden önizleyin. Klasörde zaten bekleyen veya etkin bir bağlantı varsa yeni önizlemenin uygulama komutu reddedilir. Bu durumda özgün attach komutuyla sürdürün veya kurulum yöneticisinden yardım isteyin. [PROJECT_ATTACHMENT_INCOMPLETE]\n'],
    ] as const) {
      await config(language);
      for (const scope of [maskedScope, 'Bearer']) {
        errors = ''; projectAttachment.mockResolvedValueOnce(offer(scope));
        expect.soft([await main([], bareContext), errors], `unfinished bare attachment with scope ${scope} (${language})`).toEqual([1, unfinished]);
      }
    }
  } finally { confirm.mockRestore(); }
});
it('keeps environment locale available with invalid config', async () => {
  await writeFile(join(root, '.deckent', 'config.json'), '{broken');
  env['DECKENT_LANG'] = 'tr'; await help(['run', '--help'], 'tr');
});
it('L-KIT: an error before a command reports its locale renders in the host-resolved locale, heading and body alike', async () => {
  const { ErrorRegistry } = await import('#platform/index.js');
  for (const [locale, said, never] of [['tr', 'Envanter güvenle okunamıyor', 'Inventory cannot be read'], ['en', 'Inventory cannot be read', 'Envanter güvenle okunamıyor']] as const) {
    let errors = '';
    // LANG says English; the host already resolved `locale` (flag, DECKENT_*, config language, LC_*); a failure before the command runs keeps it.
    expect(await main(['run', 'inspect', '--scope', 's'], { root, env, locale, initialize: () => { throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE'); },
      stdout: { write: () => {} }, stderr: { write: text => { errors += text; } } })).not.toBe(0);
    expect(errors).toContain(said); expect(errors).not.toContain(never);
  }
});

// alpha.53 D3: language residue - these paths resolved the locale from LANG/--lang only and ignored the configured language.
async function run(argv: readonly string[], locale?: 'tr') {
  let output = '', errors = '';
  const code = await main(argv, { root, env, ...(locale ? { locale } : {}), stdout: { write: text => { output += text; } }, stderr: { write: text => { errors += text; } } });
  return { code, output, errors };
}
it('an unknown command and --version follow the configured language', async () => {
  // The host resolves config language once into context.locale (hostLocale); the dispatcher must render with it.
  await config('tr');
  const unknown = await run(['frobnicate'], 'tr');
  expect(unknown.code).toBe(2); expect(unknown.errors + unknown.output).toContain(t('cli.unknownCommand', { name: 'deckent', version: PACKAGE_VERSION, node: process.version, platform: `${process.platform}-${process.arch}`, command: 'frobnicate' }, 'tr'));
  expect((await run(['--version'], 'tr')).output).toContain(t('cli.version', { name: 'deckent', version: PACKAGE_VERSION, node: process.version, platform: `${process.platform}-${process.arch}` }, 'tr').split('\n')[0]);
});
it('a leading --lang is the documented global option, not a command (R34)', async () => {
  const stdin = { isTTY: false } as NodeJS.ReadStream, bare = await main(['--lang', 'en'], { root, env, stdin, stdout: { write: () => undefined }, stderr: { write: () => undefined } });
  const unknown = await run(['--lang', 'en', 'frobnicate']);
  expect(bare).toBe(0); expect(unknown.code).toBe(2);
  expect(unknown.errors + unknown.output).toContain(t('cli.unknownCommand', { name: 'deckent', version: PACKAGE_VERSION, node: process.version, platform: `${process.platform}-${process.arch}`, command: 'frobnicate' }, 'en'));
});
it('run propose without its argument follows the configured language', async () => {
  await config('tr');
  const configured = await run(['run', 'propose'], 'tr'), flagged = await run(['run', 'propose', '--lang', 'tr']);
  expect(configured.code).not.toBe(0); expect(configured.errors).toBe(flagged.errors);
});

it('B27b: init help honours invocation Turkish before or after the command without loading the host', async () => {
  await config('en');
  const expected = JSON.parse(await readFile(new URL('../../fixtures/cli-help/commands-tr.json', import.meta.url), 'utf8')) as Record<string, string>;
  for (const argv of [['--lang', 'tr', 'init', '--help'], ['init', '--lang', 'tr', '--help']]) {
    let output = '';
    expect(await main(argv, { root, env, loadHost: async () => { throw new Error('Help loaded the host'); },
      stdout: { write: text => { output += text; } }, stderr: { write: () => { throw new Error('Help failed'); } },
    })).toBe(0);
    expect(output).toBe(expected['init']);
  }
});

it('B28c: language and help flags after -- belong only to the child command', async () => {
  await config('en');
  const top = await readFile(new URL('../../fixtures/cli-help/top-en.txt', import.meta.url), 'utf8');
  expect(dispatch(['--help', '--', '--lang', 'tr']).output + '\n').toBe(top);
  const expected = JSON.parse(await readFile(new URL('../../fixtures/cli-help/commands-en.json', import.meta.url), 'utf8')) as Record<string, string>;
  let output = '';
  expect(await main(['init', '--help', '--', '--lang', 'tr'], { root, env,
    loadHost: async () => { throw new Error('Help loaded the host'); }, stdout: { write: text => { output += text; } },
  })).toBe(0);
  expect(output).toBe(expected['init']);
  for (const explicit of [false, true]) {
    const child = ['node', '--lang', explicit ? 'en' : 'tr', '--help'];
    const runMcpCommand = vi.fn(async () => ({})); let locale = '';
    expect(await main([...(explicit ? ['--lang', 'tr'] : []), 'mcp', 'add', '--scope', 'project', '--no-approve', 'fixture', '--', ...child], {
      root, env, runMcpCommand, onLocale: value => { locale = value; }, stdout: { write() {} }, stderr: { write() {} },
    })).toBe(0);
    expect(locale).toBe(explicit ? 'tr' : 'en'); expect(runMcpCommand).toHaveBeenCalledOnce();
    expect(runMcpCommand.mock.calls[0]).toMatchObject({ 1: { entry: { command: 'node', args: child.slice(1) } }, 4: explicit ? 'tr' : 'en' });
  }
});
