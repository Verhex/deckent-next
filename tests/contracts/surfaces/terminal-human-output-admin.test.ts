import { describe, expect, it } from 'vitest';
import type { Locale } from '#platform/index.js';
import { terminalAdminPorts } from '#surfaces/core/terminal-admin/index.js';
import { addSessionUsage, EMPTY_SESSION_USAGE } from '#surfaces/core/terminal-kit/index.js';

// TUI2 L3 (T-HUMAN-OUTPUT): /status /scope /model /usage say what a person needs first; identities, pid and build sit under the details.
// The fixture identities are UUIDs so the "no raw UUID on the primary line" proofs are not vacuous.
const INSTALLATION = '3f2a9c1e-8b4d-4e7a-9c55-1d2e3f4a5b6c', PROJECT = 'b7d1e2f3-4a5b-4c6d-8e9f-0a1b2c3d4e5f', SERVICE = 'c9e8d7f6-1a2b-4c3d-9e8f-7a6b5c4d3e2f';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;
const channel = { channelId: 'local-vllm', access: 'allowed' as const, revision: 3, providerVersion: 1, catalogRevision: 'c1', channel: { kind: 'local-server', cli: null, billing: 'self-hosted' },
  activation: { state: 'active' }, models: [{ modelId: 'qwen3-8b', revision: 1, activation: { state: 'active' },
    model: { id: 'qwen3-8b', version: 1, lifecycle: { state: 'active' }, vendorId: 'qwen', displayName: 'Qwen 3 8B', capabilities: { tools: 'supported' }, contextWindow: 131072 } }] };
const REPORT = (locale: Locale) => [`${locale === 'en' ? 'Installation identity' : 'Kurulum kimliği'}: ${INSTALLATION}`, `${locale === 'en' ? 'Project identity' : 'Proje kimliği'}: ${PROJECT}`, 'REPORT-TAIL'].join('\n');
const ports = (locale: Locale, overrides: Record<string, unknown> = {}) => terminalAdminPorts({ root: '/work/deckent-next', scopeId: 'scope-main', installationId: INSTALLATION, projectId: PROJECT, options: {},
  locale, status: async () => REPORT(locale), doctor: async () => undefined, principalName: 'alperen', context: {
    describeTerminalChatPlan: async () => ({ status: 'ready', reference: { providerId: 'local-vllm', providerVersion: 1, modelId: 'qwen3-8b', modelVersion: 1 } }),
    inspectModelCatalog: async () => ({ schemaVersion: 1, scopeId: 'scope-main', channels: [channel] }) as never,
    describeRuntimeService: async () => ({ instanceId: SERVICE, processId: 4242, build: { sourceCommit: 'a'.repeat(40) } }),
    inspectPermissionMode: async () => ({ mode: 'standart', revision: 'p-7', supported: true, fullAccess: false }) as never,
    inspectSurfaceAccess: async () => ({ binding: 'bind-1', kinds: ['run', 'worker', 'approval'] }), ...overrides } }).inspect;
const usage = addSessionUsage(addSessionUsage(EMPTY_SESSION_USAGE, { promptTokens: 18432, completionTokens: 2310, reasoningTokens: 1200 }), { promptTokens: 20211, completionTokens: 905, reasoningTokens: null });
const run = (locale: Locale, name: 'status' | 'scope' | 'model' | 'usage', overrides?: Record<string, unknown>) => ports(locale, overrides)[name]!('', { usage });

describe.each([
  ['en', {
    status: ['Deckent is running · version 1.0.0-alpha.9 · model Qwen 3 8B (local server)', 'Details',
      `  Installation identity: ${INSTALLATION}`, `  Project identity: ${PROJECT}`, '  REPORT-TAIL', `  Runtime service now: instance ${SERVICE}, pid 4242, build aaaaaaaaaaaa`],
    scope: ['You: alperen · Project: deckent-next (b7d1e2f3) · Company: default · Mode: standard · Rule version: p-7', 'Scope: scope-main', 'Surface access: runs, workers, approvals', 'Details',
      `  Installation identity: ${INSTALLATION}`, `  Project identity: ${PROJECT}`, '  Permission mode: standart (policy revision p-7; modes supported: yes; full access allowed: no)'],
    model: ['Current model: Qwen 3 8B (local server) · tool calls supported', 'Model catalog · scope scope-main · channels: 1', '  local-vllm · local server · enabled',
      '    Qwen 3 8B (qwen3-8b) · available · enabled  <- current', 'Listed from the ledger catalog; availability of a model is not observed here.', 'Details: exact reference local-vllm@1/qwen3-8b@1'],
    usage: ['Token usage in this conversation (measured by this terminal, 2 reports)', '  Prompt: 38,643 tokens', '  Completion: 3,215 tokens',
      '  Reasoning: at least 1,200 tokens (not measured in 1 of 2 reports)', 'A measurement or account snapshot, not an invoice.'],
  }],
  ['tr', {
    status: ['Deckent çalışıyor · sürüm 1.0.0-alpha.9 · model Qwen 3 8B (yerel sunucu)', 'Ayrıntı',
      `  Kurulum kimliği: ${INSTALLATION}`, `  Proje kimliği: ${PROJECT}`, '  REPORT-TAIL', `  Çalışma servisi şimdi: örnek ${SERVICE}, pid 4242, sürüm aaaaaaaaaaaa`],
    scope: ['Siz: alperen · Proje: deckent-next (b7d1e2f3) · Şirket: varsayılan · Mod: standart · Kural sürümü: p-7', 'Kapsam: scope-main', 'Yüzey erişimi: işler, işçiler, onaylar', 'Ayrıntı',
      `  Kurulum kimliği: ${INSTALLATION}`, `  Proje kimliği: ${PROJECT}`, '  İzin modu: standart (politika revizyonu p-7; modlar destekleniyor: evet; tam erişim izinli: hayır)'],
    model: ['Geçerli model: Qwen 3 8B (yerel sunucu) · araç çağrısı destekli', 'Model kataloğu · kapsam scope-main · kanal sayısı: 1', '  local-vllm · yerel sunucu · etkin',
      '    Qwen 3 8B (qwen3-8b) · kullanılabilir · etkin  <- geçerli', 'Defter kataloğundan listelenir; bir modelin erişilebilirliği burada gözlenmez.', 'Ayrıntı: tam başvuru local-vllm@1/qwen3-8b@1'],
    usage: ['Bu konuşmadaki token kullanımı (bu terminalin ölçümü, 2 rapor)', '  İstem: 38.643 token', '  Yanıt: 3.215 token',
      '  Akıl yürütme: en az 1.200 token (2 raporun 1 tanesinde ölçülmedi)', 'Bir ölçüm ya da hesap görüntüsüdür, fatura değildir.'],
  }],
] as const)('human output (%s)', (locale, expected) => {
  it.each(['status', 'scope', 'model', 'usage'] as const)('/%s', async name => {
    expect(await run(locale, name)).toEqual(expected[name]);
  });
  it('shows no raw UUID, pid or build on the first line of /status and /scope', async () => {
    for (const name of ['status', 'scope'] as const) {
      const [first] = await run(locale, name);
      expect(first).not.toMatch(UUID); expect(first).not.toMatch(/pid|build|derleme|sürüm aaaa/iu);
    }
    expect((await run(locale, 'model'))[0]).not.toMatch(/@\d|\//u);
  });
  it('names the careful mode (standart with the ask-for-edits preference) with its own word, as the status row does (T2 integration)', async () => {
    const [first] = await run(locale, 'scope', { inspectPermissionMode: async () => ({ mode: 'standart', askEdits: true, revision: 'p-7', supported: true, fullAccess: false }) as never });
    expect(first).toContain(locale === 'en' ? 'Mode: careful ·' : 'Mod: dikkatli ·');
    const [full] = await run(locale, 'scope', { inspectPermissionMode: async () => ({ mode: 'full-access', askEdits: false, revision: 'p-7', supported: true, fullAccess: true }) as never });
    // Astra 2431 P2: a stored full-access start mode the session does not hold runs as standart, and /scope says so.
    expect(full).toContain(locale === 'en' ? 'Mode: standard (stored start mode full access, not held by this session) ·' : 'Mod: standart (kayıtlı başlangıç modu tam erişim, bu oturumda etkin değil) ·');
  });
  it('Astra 2431 P2: during session-only full access /scope names the mode this session runs in, with the stored mode the next launch takes', async () => {
    const stored = { inspectPermissionMode: async () => ({ mode: 'full-auto', askEdits: false, revision: 'p-7', supported: true, fullAccess: true }) as never };
    const [first] = await ports(locale, stored).scope!('', { usage, sessionFullAccess: true });
    expect(first).toContain(locale === 'en' ? 'Mode: full access (this session only; stored mode full auto) ·' : 'Mod: tam erişim (yalnız bu oturum; kayıtlı mod tam otomatik) ·');
    expect((await ports(locale, stored).scope!('', { usage, sessionFullAccess: false }))[0]).toContain(locale === 'en' ? 'Mode: full auto ·' : 'Mod: tam otomatik ·');
  });
  it('names a service that could not be read instead of saying it is running', async () => {
    const lines = await run(locale, 'status', { describeRuntimeService: async () => { throw new Error('boom'); } });
    expect(lines[0]).toContain(locale === 'en' ? 'runtime service not read' : 'çalışma servisi okunamadı'); expect(lines[0]).not.toMatch(/is running|çalışıyor/u);
  });
});
