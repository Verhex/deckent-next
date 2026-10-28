import { describe, expect, it, vi } from 'vitest';
import { configCommand, configPanelPort, narrowConfigPanel, type ConfigPanelOpener } from '#surfaces/core/config/index.js';
import { parseConfigInput } from '#engine/index.js';

// C-SETUP (review §config, owner 2026-10-19): bare `deckent config` off a terminal = overrides + group count + where the rest is; on a
// terminal = the `/config` window (one implementation, bound by composition); `set <key>` without a value is chosen, never typed.
const field = (key: string, value: unknown, source: 'default' | 'project' | 'global' | 'env', extra: Record<string, unknown> = {}) => ({ key, value, defaultValue: null,
  descriptionKey: 'config.field.max_workers', description: 'Workers', schema: { type: 'number', minimum: 1, maximum: 64 }, source,
  binding: { state: 'bound', consumers: ['src/composition/core/runs'] }, apply: 'restart', redacted: false, ...extra }) as const;
const fields = [field('projectName', 'demo', 'project'), field('max_workers', 4, 'project'), field('language', 'en', 'global'),
  field('artifacts.maxBytes', 16777216, 'default'), field('artifacts.maxInputs', 64, 'default'), field('terminal.theme', 'auto', 'default')];
const snapshot = { schemaVersion: 1 as const, digest: 'digest', layer: 'project' as const, fields };
const tty = { isTTY: true, setRawMode: () => undefined } as never;

function fixture(extra: Record<string, unknown> = {}) {
  const output: string[] = [], errors: string[] = [];
  const submit = vi.fn(async () => ({ status: 'applied' as const, result: {}, approvalId: null }));
  const app = { inspect: vi.fn(async () => snapshot), explain: vi.fn(async ({ keyPath }: { keyPath: string }) => {
    const found = fields.find(item => item.key === keyPath); if (!found) throw Object.assign(new Error('unknown'), { code: 'CONFIG_KEY_UNKNOWN' }); return found;
  }), validate: vi.fn(async () => ({ valid: true as const })), submit, permissions: vi.fn(async () => []) };
  const context = { root: '/tmp/config-cli-human', env: {}, stdout: { write: (s: string) => { output.push(s); } }, stderr: { write: (s: string) => { errors.push(s); } },
    configApplication: () => app as never, resolveConfigPrincipal: async () => ({ id: 'p', issuer: 'local', subject: 'p', assurance: 'os-user', scopeIds: ['s'] }) as never, ...extra };
  return { output, errors, app, submit, context };
}

describe('C-SETUP: bare deckent config', () => {
  it('off a terminal prints only the values set here, the group count and where everything is (EN and TR), never the full dump', async () => {
    for (const locale of ['en', 'tr'] as const) {
      const f = fixture({ locale }); await configCommand(['config'], f.context);
      const text = f.output.join('');
      expect(text).toContain('max_workers'); expect(text).toContain('language'); expect(text).not.toContain('artifacts.maxInputs'); expect(text).not.toContain('terminal.theme');
      expect(text).toContain('deckent config get --json');
      expect(text).toContain(locale === 'en' ? '5 groups, 6 keys.' : '5 grup, 6 anahtar.');
    }
  });
  it('--json keeps the full typed view (AI contract unchanged)', async () => {
    const f = fixture(); await configCommand(['config', '--json'], f.context); expect(JSON.parse(f.output.join(''))).toEqual(snapshot);
  });
  it('on a person\'s terminal opens the bound /config window with the shared port; a pipe, an agent or --json never opens it', async () => {
    const opened = vi.fn<ConfigPanelOpener>(async () => ['Saved']);
    const f = fixture({ openConfigPanel: opened, stdin: tty, stdout: { isTTY: true, columns: 100, write: (s: string) => { f.output.push(s); } } });
    await configCommand(['config'], f.context);
    expect(opened).toHaveBeenCalledOnce(); expect(f.output.join('')).toContain('Saved'); expect(f.app.inspect).not.toHaveBeenCalled();
    const port = opened.mock.calls[0]![0];
    expect(typeof port.inspect).toBe('function'); expect(typeof port.write).toBe('function'); expect(port.records).toBeDefined();
    for (const extra of [{ stdin: { isTTY: false } }, { env: { CLAUDECODE: '1' } }]) {
      const again = vi.fn<ConfigPanelOpener>(async () => []), g = fixture({ openConfigPanel: again, stdin: tty, stdout: { isTTY: true, write: () => undefined }, ...extra });
      await configCommand(['config'], g.context); expect(again).not.toHaveBeenCalled();
    }
    const json = vi.fn<ConfigPanelOpener>(async () => []), h = fixture({ openConfigPanel: json, stdin: tty, stdout: { isTTY: true, write: () => undefined } });
    await configCommand(['config', '--json'], h.context); expect(json).not.toHaveBeenCalled();
  });
});

describe('C-SETUP: config set, explain, get', () => {
  it('NEGATIVE: set <key> without a value off a terminal is refused with what the key takes, and nothing is submitted', async () => {
    const f = fixture();
    await expect(configCommand(['config', 'set', 'max_workers'], f.context)).rejects.toMatchObject({ code: 'CLI_CONFIG_VALUE_MISSING' });
    expect(f.submit).not.toHaveBeenCalled();
  });
  // BeUser KER-02/KER-05: a refusal names the key the person typed (never a literal `{key}`) and what the key takes, with the next step.
  it('NEGATIVE: an unknown key is named with the command that lists every key; a value that is not JSON names what the key takes; nothing is submitted', async () => {
    const unknown = (() => { try { parseConfigInput('no.such.option', '7'); } catch (error) { return error as { code: string; params?: unknown; message: string }; } throw new Error('expected'); })();
    expect(unknown).toMatchObject({ code: 'CONFIG_KEY_UNKNOWN', params: { key: 'no.such.option' } });
    expect(unknown.message).toBe('Unknown configuration key: no.such.option. Every key and what it is: deckent config explain.');
    const f = fixture({ locale: 'en' });
    f.app.explain.mockImplementation(async () => field('language', 'en', 'global', { schema: { type: 'string', enum: ['en', 'tr'] } }) as never);
    const error = await configCommand(['config', 'set', 'language', 'xx'], f.context).then(() => null, (failure: unknown) => failure as { code: string; message: string });
    expect(error).toMatchObject({ code: 'CLI_CONFIG_VALUE_NOT_JSON', params: { key: 'language', values: 'en, tr' } });
    expect(error!.message).toContain('It takes: en, tr.'); expect(error!.message).toContain(`deckent config set language '"<value>"'`);
    expect(f.submit).not.toHaveBeenCalled();
  });
  // CONFIG-PARTIAL-CLI: off a terminal the refusal lists what the key takes; a list cut short says so (EN/TR) and carries the cut as data.
  it('set <key> without a value off a terminal says when the listed values are partial (time, size; EN/TR) and says nothing for a complete list', async () => {
    const image = field('execution.docker.imageId', 'sha256:old', 'default', { schema: { type: 'string' } });
    const found = [{ id: 'r0', label: 'Docker · 0123', value: 'sha256:0123' }, { id: 'r1', label: 'Docker · 4567', value: 'sha256:4567' }];
    const refusal = async (partial: 'time' | 'size' | false, locale: 'en' | 'tr', choices = found, json = false) => {
      const f = fixture({ locale, configChoiceSources: () => ({ list: async () => Object.freeze(Object.assign([...choices], { partial })) }) });
      f.app.explain.mockImplementation(async () => image as never);
      const error = await configCommand(['config', 'set', 'execution.docker.imageId', ...(json ? ['--json'] : [])], f.context).then(() => null, (failure: unknown) => failure as { code: string; params?: Record<string, unknown>; message: string });
      expect(f.submit).not.toHaveBeenCalled(); return error!;
    };
    const time = await refusal('time', 'en');
    expect(time).toMatchObject({ code: 'CLI_CONFIG_VALUE_MISSING', params: { key: 'execution.docker.imageId', values: 'Docker · 0123, Docker · 4567', partial: 'time', found: 2 } });
    expect(time.message).toBe('Missing value for execution.docker.imageId. It takes: Docker · 0123, Docker · 4567. Choose it on a terminal with deckent config set execution.docker.imageId, '
      + 'or give it as JSON: deckent config set execution.docker.imageId <json>. This list is partial: discovery stopped at its time limit with 2 found.');
    expect((await refusal('time', 'tr')).message).toContain('Bu liste eksik: keşif süre sınırında durdu, 2 değer bulundu.');
    const size = await refusal('size', 'en', found, true);
    expect(size.params).toMatchObject({ partial: 'size', found: 2 }); expect(size.message).toContain('This list is partial: discovery stopped at its size limit with 2 found.');
    expect((await refusal('size', 'tr')).message).toContain('Bu liste eksik: keşif boyut sınırında durdu, 2 değer bulundu.');
    // Nothing found before the limit: the schema word stands in for the values, and the cut is still said.
    const none = await refusal('time', 'en', []);
    expect(none.params).toMatchObject({ partial: 'time', found: 0 }); expect(none.message).toContain('It takes: a value of type '); expect(none.message).toContain('with 0 found.');
    const complete = await refusal(false, 'en');
    expect(complete.params).not.toHaveProperty('partial'); expect(complete.params).not.toHaveProperty('found'); expect(complete.message).not.toContain('partial');
  });
  it('set <key> without a value on a terminal opens the same window narrowed to that key', async () => {
    const opened = vi.fn<ConfigPanelOpener>(async () => ['chosen']);
    const f = fixture({ openConfigPanel: opened, stdin: tty, stdout: { isTTY: true, write: (s: string) => { f.output.push(s); } } });
    await configCommand(['config', 'set', 'max_workers'], f.context);
    expect(opened).toHaveBeenCalledOnce(); expect(f.output.join('')).toBe('chosen\n'); expect(f.submit).not.toHaveBeenCalled();
    // The narrowing keeps the port (same write path) and lists only that key.
    const view = { title: 't', notes: [], fields: [{ key: 'max_workers' }, { key: 'language' }] };
    const port = { inspect: async () => view, parse: () => ({ ok: false as const, reason: '-' }), write: vi.fn(), records: {} } as never;
    const narrowed = narrowConfigPanel(port, 'max_workers');
    expect((await narrowed.inspect()).fields.map(item => item.key)).toEqual(['max_workers']); expect(narrowed.write).toBe((port as { write: unknown }).write);
  });
  it('NEGATIVE: a typed value outside the key\'s schema is refused by the window before anything is written', async () => {
    const f = fixture(), port = configPanelPort('/tmp/config-cli-human', f.context as never, {}, 'en');
    expect(port.parse('artifacts.maxInputs', 'many')).toMatchObject({ ok: false }); expect(f.submit).not.toHaveBeenCalled();
  });
  it('bare explain lists every key with what it is; explain hides internal consumers unless --verbose', async () => {
    const f = fixture({ locale: 'tr' });
    await configCommand(['config', 'explain'], f.context);
    expect(f.output.join('')).toContain('artifacts.maxInputs'); expect(f.output.join('')).toContain('deckent config explain <anahtar>');
    f.output.length = 0; await configCommand(['config', 'explain', 'max_workers'], f.context);
    expect(f.output.join('')).not.toContain('src/composition'); expect(f.output.join('')).toContain('bağlı');
    f.output.length = 0; await configCommand(['config', 'explain', 'max_workers', '--verbose'], f.context);
    expect(f.output.join('')).toContain('src/composition/core/runs');
    await expect(configCommand(['config', '--verbose'], f.context)).rejects.toMatchObject({ code: 'CLI_USAGE' });
  });
  it('validate and explain follow the call\'s language (config language reaches them through the host locale)', async () => {
    const f = fixture({ locale: 'tr' }); await configCommand(['config', 'validate'], f.context); expect(f.output.join('')).toBe('Yapılandırma geçerli.\n');
  });
});
