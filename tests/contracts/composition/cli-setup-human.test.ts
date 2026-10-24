import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { main } from '#surfaces/index.js';
import { codingCommand, operationCommand } from '#surfaces/core/cli-admin/index.js';
import { inferenceCommand } from '#surfaces/core/cli-models/index.js';
import { configCommand, terminalConfigWrite, type ConfigPanelOpener } from '#surfaces/core/config/index.js';
import { composeCore } from '#composition/core/root/index.js';
import { compileNativeCodingDockerProfile } from '#adapters/index.js';
import { clearConfigCache, ErrorRegistry, resolveGlobalConfigPaths } from '#platform/index.js';

// C-SETUP (review §coding, §operation, §inference): bare commands read; missing choices are named; errors name the right field and exit code.
const roots: string[] = [];
beforeAll(() => { composeCore(); });
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const configured = `sha256:${'a'.repeat(64)}`, admitted = `sha256:${'b'.repeat(64)}`;
const docker = (imageId: string) => ({ executable: 'docker', imageId, memoryBytes: 268435456, cpus: 1, pids: 64, logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216,
  deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 });
function pin(imageId: string) {
  const { executable, ...task } = docker(imageId); void executable;
  return compileNativeCodingDockerProfile({ id: 'admitted', version: 1, adapter: { id: 'docker', version: 2 }, parameters: { ...task, argv: ['unused'] } },
    { schemaVersion: 4, provider: 'claude', cliVersion: '2.1.303 (Claude Code)', discovery: { schemaVersion: 1, mode: 'repository' }, permissionMode: 'unattended',
      model: { channelId: 'seed', modelId: 'claude-sonnet-5-5', auxiliaryModelIds: [] }, composition: { schemaVersion: 1, task: 'fixture', scope: 'note.txt', acceptance: 'fixture' } });
}
async function project(document: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'cli-setup-human-')); roots.push(root);
  const home = join(root, 'home'), projectRoot = join(root, 'project');
  const env = { HOME: home, USERPROFILE: home, APPDATA: join(home, 'roaming'), LOCALAPPDATA: join(home, 'local'), XDG_CONFIG_HOME: join(home, '.config') };
  const path = join(projectRoot, '.deckent', 'config.json');
  await Promise.all([mkdir(dirname(resolveGlobalConfigPaths(env).platformPath), { recursive: true }), mkdir(dirname(path), { recursive: true })]);
  await writeFile(path, JSON.stringify(document));
  return { projectRoot, env, path };
}
async function run(f: { projectRoot: string; env: Record<string, string> }, args: readonly string[], extra: Record<string, unknown> = {}) {
  const stdout: string[] = [], stderr: string[] = [];
  const code = await main(args, { initialize: composeCore, root: f.projectRoot, env: f.env, stdout: { write(value: string) { stdout.push(value); } },
    stderr: { write(value: string) { stderr.push(value); } }, ...extra });
  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}
/** A bare family reaches its handler once the catalog marks it `bare: 'handler'` (lead delta); the handler's own read is tested here. */
async function bare(handler: (argv: readonly string[], context: never) => Promise<void>, f: { projectRoot: string; env: Record<string, string> }, args: readonly string[]) {
  const stdout: string[] = [];
  await handler(args, { root: f.projectRoot, env: f.env, stdout: { write(value: string) { stdout.push(value); } } } as never);
  return stdout.join('');
}
const codingConfig = () => {
  const profile = pin(admitted);
  return { execution: { docker: docker(configured), git: { gitExecutable: 'git', timeoutMs: 5000 } },
    admission: { registry: { schemaVersion: 1, revision: 'r1', profiles: [profile], kinds: [{ kind: 'claude-coding', profile: { id: profile.id, version: profile.version } }],
      evaluators: [{ id: 'process-exit', version: 1, implementation: { id: 'process-exit', version: 1 } }] }, poolId: 'p', executionSlots: 1, inFlightSlots: 1, ordering: 'input-order' } };
};

describe.skipIf(process.platform === 'win32')('C-SETUP coding', () => {
  it('bare coding lists the profiles task kinds run on, and says the configured image runs none of them (EN/TR, JSON)', async () => {
    const f = await project(codingConfig());
    for (const [lang, word] of [['en', 'Configured worker image'], ['tr', 'Yapılandırılmış worker imajı']] as const) {
      const text = await bare(codingCommand, f, ['coding', '--lang', lang]);
      expect(text).toContain('claude-coding'); expect(text).toContain('2.1.303'); expect(text).toContain('b'.repeat(12)); expect(text).toContain(word);
      expect(text).toContain(lang === 'en' ? 'No admitted CLI runs on the configured image' : 'Yapılandırılmış imajda kabul edilmiş bir CLI çalışmıyor');
    }
    expect(JSON.parse(await bare(codingCommand, f, ['coding', '--json']))).toMatchObject({ schemaVersion: 1, configuredImageId: configured, profiles: [{ kind: 'claude-coding', provider: 'claude', imageId: admitted }] });
  });
  it('NEGATIVE: template without --provider off a terminal lists the admitted providers and never calls the template', async () => {
    const f = await project(codingConfig()), template = vi.fn();
    const result = await run(f, ['coding', 'template', '--kind', 'coding', '--preview'], { configureCodingTemplate: template });
    expect(result.code).toBe(2); expect(result.stderr).toContain('--provider'); expect(result.stderr).toContain('claude'); expect(template).not.toHaveBeenCalled();
    const kind = await run(f, ['coding', 'template', '--provider', 'claude', '--preview'], { configureCodingTemplate: template });
    expect(kind.code).toBe(2); expect(kind.stderr).toContain('claude-coding'); expect(template).not.toHaveBeenCalled();
  });
  it('J3: an empty installation says in words that there are no admitted choices yet (EN/TR), never a bare "-"', async () => {
    const f = await project({}), template = vi.fn();
    for (const [lang, words] of [['en', 'Admitted choices here: none yet.'], ['tr', 'Bu kurulumda kabul edilmiş seçenekler: henüz yok.']] as const) {
      // No admitted coding CLI yet: the provider list is empty (the task kinds always offer the template's own kinds).
      const result = await run(f, ['coding', 'template', '--kind', 'coding', '--preview', '--lang', lang], { configureCodingTemplate: template });
      expect(result.code).toBe(2); expect(result.stderr).toContain('CLI_CODING_TEMPLATE_CHOICE_MISSING'); expect(result.stderr).toContain(words);
      expect(result.stderr).not.toMatch(/: -\./u);
    }
    expect(template).not.toHaveBeenCalled();
  });
  it('root cause: TOOLCHAIN_REQUIRED on a configured image with no admitted CLI names the admitted images and the command that works', async () => {
    const f = await project(codingConfig());
    const template = vi.fn(async () => { throw ErrorRegistry.createError('CODING_TEMPLATE_TOOLCHAIN_REQUIRED'); });
    const result = await run(f, ['coding', 'template', '--provider', 'claude', '--kind', 'coding', '--preview', '--lang', 'tr'], { configureCodingTemplate: template });
    expect(result.code).toBe(78); expect(result.stderr).toContain('CLI_CODING_TEMPLATE_IMAGE_UNADMITTED');
    expect(result.stderr).toContain('a'.repeat(12)); expect(result.stderr).toContain(`--image ${admitted}`);
    // With an admitted image the engine's own error is not re-worded.
    const same = await run(f, ['coding', 'template', '--provider', 'claude', '--kind', 'coding', '--preview', '--image', admitted], { configureCodingTemplate: template });
    expect(same.stderr).toContain('CODING_TEMPLATE_TOOLCHAIN_REQUIRED');
  });
  it('NEGATIVE: prepare names the first field of the document that does not fit and never prepares', async () => {
    const f = await project({}), prepare = vi.fn(), input = join(f.projectRoot, 'prepare.json');
    for (const [document, field] of [[{}, 'schemaVersion'], [{ schemaVersion: 1, template: { id: 'x' }, invocation: {} }, 'template.'], [{ schemaVersion: 1, extra: 1 }, 'extra']] as const) {
      await writeFile(input, JSON.stringify(document));
      const result = await run(f, ['coding', 'prepare', '--input', input, '--lang', 'en'], { prepareCodingProfile: prepare });
      expect(result.code).toBe(2); expect(result.stderr).toContain('CLI_CODING_PREPARE_FIELD_INVALID'); expect(result.stderr).toContain(field);
    }
    expect(prepare).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform === 'win32')('C-SETUP operation', () => {
  it('bare operation says the catalog is empty and where operations are defined (EN/TR); JSON is the typed catalog', async () => {
    const f = await project({});
    expect(await bare(operationCommand, f, ['operation', '--lang', 'en'])).toContain('No operation is defined in this installation');
    expect(await bare(operationCommand, f, ['operation', '--lang', 'tr'])).toContain('Bu kurulumda tanımlı işlem yok');
    expect(JSON.parse(await bare(operationCommand, f, ['operation', '--json']))).toEqual({ schemaVersion: 1, catalog: [], targets: [] });
  });
  it('inspect of an unrecorded command fails with exit 1 in the call\'s language', async () => {
    const f = await project({}), inspectOperation = vi.fn(async () => ({ schemaVersion: 1 as const, record: null }));
    const result = await run(f, ['operation', 'inspect', '--scope', 's', '--command-id', 'none', '--lang', 'tr'], { inspectOperation });
    expect(result.code).toBe(1); expect(result.stderr).toContain('s kapsamında none için kayıtlı işlem yok'); expect(result.stdout).toBe('');
    // J2e: the --json contract is unchanged (record null, exit 0), the same answer as the SDK and MCP.
    const machine = await run(f, ['operation', 'inspect', '--scope', 's', '--command-id', 'none', '--json'], { inspectOperation });
    expect(machine.code).toBe(0); expect(JSON.parse(machine.stdout)).toEqual({ schemaVersion: 1, record: null });
  });
  it('NEGATIVE: execute with a document that is not an effect command names the field, sends nothing; --schema prints the contract', async () => {
    const f = await project({}), executeOperation = vi.fn(), input = join(f.projectRoot, 'op.json');
    await writeFile(input, JSON.stringify({ schemaVersion: 1 }));
    const result = await run(f, ['operation', 'execute', '--input', input, '--lang', 'en'], { executeOperation });
    expect(result.code).toBe(2); expect(result.stderr).toContain('CLI_OPERATION_INPUT_INVALID'); expect(result.stderr).not.toContain('INVENTORY_QUERY_INVALID');
    expect(result.stderr).toMatch(/field (commandId|scopeId|operation|target|idempotencyKey|expectedVersion)/u); expect(executeOperation).not.toHaveBeenCalled();
    const schema = await run(f, ['operation', 'execute', '--schema']);
    expect(schema.code).toBe(0); expect(JSON.parse(schema.stdout)).toMatchObject({ type: 'object', properties: { commandId: expect.anything(), target: expect.anything() } });
    expect(executeOperation).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform === 'win32')('C-SETUP inference', () => {
  it('bare inference without a serving profile says what it is for and where to define it (EN/TR); JSON says none', async () => {
    const f = await project({});
    const en = await bare(inferenceCommand, f, ['inference', '--lang', 'en']), tr = await bare(inferenceCommand, f, ['inference', '--lang', 'tr']);
    expect(en).toContain('No local inference serving profile is defined.'); expect(en).toContain('deckent config → inference_serving');
    expect(tr).toContain('Yerel çıkarım (inference serving) profili tanımlı değil.');
    expect(JSON.parse(await bare(inferenceCommand, f, ['inference', '--json']))).toEqual({ schemaVersion: 1, profileId: null, plan: null, localModels: [] });
    expect(await readFile(f.path, 'utf8')).toBe('{}');
  });
});

describe.skipIf(process.platform === 'win32')('C-SETUP: the /config window\'s CLI write names the command that applies an approved change', () => {
  it('an approval-pending write from deckent config prints the exact command with its command id and expected digest; the terminal keeps its wording', async () => {
    const f = await project({ terminal: { scopeId: 's' } });
    const outcome = { status: 'approval-pending' as const, commandId: 'cmd-1', expect: 'digest-1', approval: { approvalId: 'appr-1', summary: 'Setting will change' } };
    const submit = vi.fn(async () => outcome), explain = vi.fn(async () => ({ redacted: false }));
    const context = { root: f.projectRoot, env: f.env, configApplication: () => ({ submit, explain }) as never,
      resolveConfigPrincipal: async () => ({ id: 'p', issuer: 'local', subject: 'p', assurance: 'os-user', scopeIds: ['s'] }) as never };
    const cli = await terminalConfigWrite(f.projectRoot, { action: 'set', keyPath: 'terminal.theme', value: "it's" }, context, { env: f.env }, 'en', 'cli');
    expect(cli.status).toBe('approval-pending');
    expect(cli.lines.join('\n')).toContain("deckent config set terminal.theme '\"it'\\''s\"' --scope s --command-id cmd-1 --expect digest-1");
    const terminal = await terminalConfigWrite(f.projectRoot, { action: 'set', keyPath: 'terminal.theme', value: 'dark' }, context, { env: f.env }, 'en');
    expect(terminal.lines.join('\n')).not.toContain('--command-id'); expect(explain).toHaveBeenCalledOnce();
  });
});

describe.skipIf(process.platform === 'win32')('C-SETUP security review (be23372e): a redacted value is never echoed by the CLI window', () => {
  const secret = 'sk-CANARY-SECRET-0123456789abcdef';
  const pending = { status: 'approval-pending' as const, commandId: 'cmd-2', expect: 'digest-2', keyPath: 'terminal.chat.apiKey', layer: 'project' as const,
    approval: { approvalId: 'appr-2', summary: 'Setting will change: terminal.chat.apiKey [REDACTED] → [REDACTED] (project)' } };
  const context = (f: { projectRoot: string; env: Record<string, string> }, redacted: boolean, extra: Record<string, unknown> = {}) => ({ root: f.projectRoot, env: f.env,
    configApplication: () => ({ submit: vi.fn(async () => pending), explain: vi.fn(async ({ keyPath }: { keyPath: string }) => ({ key: keyPath, redacted, value: redacted ? '[REDACTED]' : 'x',
      apply: 'live' })) }) as never,
    resolveConfigPrincipal: async () => ({ id: 'p', issuer: 'local', subject: 'p', assurance: 'os-user', scopeIds: ['s'] }) as never, ...extra });
  it('NEGATIVE: a pending write of a redacted key names the command with a placeholder; the value bytes appear nowhere', async () => {
    const f = await project({ terminal: { scopeId: 's' } });
    for (const [key, redacted] of [['terminal.chat.apiKey', true], ['terminal.theme', true], ['service.authToken', false]] as const) {
      // alpha.55.1: `service.*` is protected, so the write comes from a person's terminal (the case is the redaction, not the witness).
      const result = await terminalConfigWrite(f.projectRoot, { action: 'set', keyPath: key, value: secret }, context(f, redacted, { stdin: { isTTY: true }, stdout: { isTTY: true } }), { env: f.env }, 'en', 'cli');
      expect(result.status).toBe('approval-pending'); expect(result.lines.join('\n')).not.toContain(secret); expect(result.lines.join('\n')).toContain('<value>');
    }
    // A value shaped like a credential is hidden even on a key that is not redacted by name.
    const shaped = await terminalConfigWrite(f.projectRoot, { action: 'set', keyPath: 'terminal.theme', value: '$DECK:API_TOKEN' }, context(f, false), { env: f.env }, 'en', 'cli');
    expect(shaped.lines.join('\n')).not.toContain('$DECK:API_TOKEN');
  });
  it('NEGATIVE: through deckent config on a terminal (window path) and with --json, the chosen secret is not printed', async () => {
    const f = await project({ terminal: { scopeId: 's' } }), output: string[] = [];
    const opener: ConfigPanelOpener = async port => { await port.write({ action: 'set', keyPath: 'terminal.chat.apiKey', value: secret, layer: 'project' }); return []; };
    const sink = { isTTY: true, columns: 100, write: (value: string) => { output.push(value); } };
    await configCommand(['config'], context(f, true, { openConfigPanel: opener, stdin: { isTTY: true, setRawMode: () => undefined }, stdout: sink }) as never);
    expect(output.join('')).toContain('appr-2'); expect(output.join('')).not.toContain(secret);
    output.length = 0;
    await configCommand(['config', 'set', 'terminal.chat.apiKey', JSON.stringify(secret), '--scope', 's', '--json'], context(f, true, { stdout: sink }) as never);
    expect(output.join('')).not.toContain(secret); expect(JSON.parse(output.join('')).status).toBe('approval-pending');
  });
});
