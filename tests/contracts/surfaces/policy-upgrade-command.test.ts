import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import * as cards from '#surfaces/core/cli-human/index.js';
import { personMarkersUnset } from '../support/person-env.js';
import { main } from '#surfaces/index.js';
import { homeEnv } from '../support/host-platform.js';
import { describePolicyChange, firstRunPolicyTemplate, firstRunExecutionRules } from '#domain/index.js';
import { FIRST_RUN_TOOL_NAMES, policyExecutionLines } from '#engine/index.js';

// Owner request 2026-10-07: `deckent policy upgrade --template v5` — preview by default (writes nothing), `--apply [--expect <revision>]`, `--rollback`;
// the surface only words the engine's result (what would be added, what the person lacks) in EN/TR.
function context(result: Record<string, unknown>, calls: unknown[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'deckent-policy-upgrade-')); mkdirSync(join(root, '.deckent'));
  const out: string[] = [], errors: string[] = [];
  return { out, errors, ctx: { root, env: homeEnv(root), stdout: { write(value: string) { out.push(value); } }, stderr: { write(value: string) { errors.push(value); } },
    async upgradePolicyTemplate(_root: string, scopeId: string, input: unknown) { calls.push([scopeId, input]); return result; } } as never };
}
const PREVIEW = { schemaVersion: 1, status: 'preview', revision: 'first-run-template-v4+b', summary: 'policy.administer@1 · 3 changes\n+ grant first-run-mcp-servers: allow mcp-server*', missing: [], reason: null, rules: [] };

it('119-C2-P: governed and installer previews show every ordered line, including an AI-only overflow; JSON stays an object', async () => {
  const person = { issuer: 'person', subject: 'one' }, ai = firstRunExecutionRules([], person, ['scope']).wanted;
  const human = Array.from({ length: 26 }, (_, i) => ({ ...ai[0]!, id: `human-${i}`, principals: [person] }));
  const onlyAi = Array.from({ length: 10 }, (_, i) => ai.map(rule => ({ ...rule, id: `ai-${i}-${rule.id}` }))).flat();
  for (const rules of [[...human, ...ai], onlyAi]) {
    const summary = describePolicyChange({ policy: { schemaVersion: 2, revision: 'p', roles: [], grants: [], restrictions: [], separationOfDuties: [] },
      bindings: { schemaVersion: 2, revision: 'b', bindings: [], modes: [] } }, { schemaVersion: 1, changes: rules.map(grant => ({ kind: 'grant.add', grant })) })!;
    expect(summary.length).toBeGreaterThan(2048);
    expect(summary.split('\n')).toHaveLength(rules.length + 1);
    const result = { ...PREVIEW, summary, rules };
    const { out, ctx } = context(result);
    expect(await main(['policy', 'upgrade', '--template', 'current', '--scope', 'scope', '--preview'], ctx)).toBe(0);
    expect(out.join('')).toContain(summary); out.length = 0;
    expect(await main(['policy', 'upgrade', '--template', 'current', '--scope', 'scope', '--preview', '--json'], ctx)).toBe(0);
    expect(JSON.parse(out.join(''))).toEqual(result); out.length = 0;
    const installation = { ...ctx, async upgradePolicyTemplateInstallation() { return { status: 'preview', basis: 'first-run', rules, revision: 'r', conflicts: [], wireRules: [] }; } };
    expect(await main(['init', 'policy', '--scope', 'scope', '--upgrade', '--preview', '--lang', 'en'], installation)).toBe(0);
    const printed = out.join('');
    for (const rule of rules) expect(printed).toContain(rule.id);
    if (rules === onlyAi) expect(printed).toContain('ai-9-');
    else expect(printed.indexOf(ai[0]!.id)).toBeLessThan(printed.indexOf('human-0'));
  }
});

it('119-C2: all EN/TR person previews show genuine breadth, withhold it for reused ids, and preserve a genuine partial upgrade', async () => {
  const template = firstRunPolicyTemplate({ scopeId: 'scope', principal: { issuer: 'person', subject: 'one' }, ...FIRST_RUN_TOOL_NAMES });
  const rules = firstRunExecutionRules([], { issuer: 'person', subject: 'one' }, ['scope']).wanted;
  for (const locale of ['en', 'tr'] as const) for (const variant of [
    { changed: rules, executionContext: [], included: true },
    { changed: rules.map(rule => ({ ...rule, scopes: ['scope', 'other'] })), executionContext: [], included: false },
    { changed: rules.map((rule, i) => i === 0 ? { ...rule, principals: [{ issuer: 'person/mcp', subject: 'other' }] } : rule), executionContext: [], included: false },
    { changed: rules.slice(1), executionContext: rules.slice(0, 1), included: true },
  ]) {
    const { changed, executionContext, included } = variant;
    const { out, ctx } = context({ ...PREVIEW, rules: changed, executionContext });
    const notice = policyExecutionLines(rules, 'scope', locale)[0]!;
    expect(await main(['policy', 'upgrade', '--template', 'current', '--scope', 'scope', '--preview', '--lang', locale], ctx)).toBe(0);
    expect(out.join('').includes(notice)).toBe(included); out.length = 0;
    const installation = { ...ctx, async upgradePolicyTemplateInstallation() { return { status: 'preview', basis: 'first-run', rules: changed, executionContext, revision: 'r', conflicts: [], wireRules: [] }; },
      async previewPolicyTemplateInstallation() { return { ...template, policy: { ...template.policy, grants: [...executionContext, ...changed] }, scopeId: 'scope', principal: { issuer: 'person', subject: 'one' } }; } };
    expect(await main(['init', 'policy', '--scope', 'scope', '--upgrade', '--preview', '--lang', locale], installation)).toBe(0);
    expect(out.join('').includes(notice)).toBe(included); out.length = 0;
    expect(await main(['init', 'policy', '--scope', 'scope', '--preview', '--lang', locale], installation)).toBe(0);
    expect(out.join('').includes(notice)).toBe(included);
  }
});

it('previews by default with the exact apply command, and applies only with --apply (and the previewed --expect)', async () => {
  const calls: unknown[] = [], { out, ctx } = context(PREVIEW, calls);
  expect(await main(['policy', 'upgrade', '--template', 'v5', '--scope', 'scope', '--lang', 'en'], ctx)).toBe(0);
  expect(out.join('')).toContain('deckent policy upgrade --template current --scope scope --apply --expect first-run-template-v4+b');
  expect(out.join('')).toContain('+ grant first-run-mcp-servers');
  expect(await main(['policy', 'upgrade', '--template', 'v5', '--scope', 'scope', '--apply', '--expect', 'first-run-template-v4+b'], ctx)).toBe(0);
  // V20 proposal rollback selects its family; the default rollback is v21 execution.
  expect(await main(['policy', 'upgrade', '--template', 'current', '--scope', 'scope', '--apply', '--only', 'ai-proposals'], ctx)).toBe(0);
  expect(await main(['policy', 'upgrade', '--template', 'current', '--scope', 'scope', '--rollback', '--only', 'ai-proposals'], ctx)).toBe(0);
  out.length = 0;
  expect(await main(['policy', 'upgrade', '--template', 'current', '--scope', 'scope', '--only', 'ai-proposals', '--lang', 'en'], ctx)).toBe(0);
  expect(out.join('')).toContain('deckent policy upgrade --template current --scope scope --only ai-proposals --apply --expect first-run-template-v4+b');
  for (const extra of [['--apply', '--only', 'everything']]) expect(await main(['policy', 'upgrade', '--template', 'current', '--scope', 'scope', ...extra], ctx)).toBe(2);
  expect(calls).toEqual([['scope', { mode: 'preview', reason: expect.any(String) }], ['scope', { mode: 'apply', reason: expect.any(String), expect: 'first-run-template-v4+b' }],
    ['scope', { mode: 'apply', reason: expect.any(String), only: 'ai-proposals' }], ['scope', { mode: 'rollback', reason: expect.any(String), only: 'ai-proposals' }], ['scope', { mode: 'preview', reason: expect.any(String), only: 'ai-proposals' }]]);
});
it.each(['en', 'tr'] as const)('uses the same current handler for current and deprecated v5 selectors in %s, preserving JSON stdout', async locale => {
  const calls: unknown[] = [], { out, errors, ctx } = context(PREVIEW, calls);
  expect(await main(['policy', 'upgrade', '--template', 'current', '--scope', 'scope', '--json', '--lang', locale], ctx)).toBe(0);
  expect(errors).toEqual([]);
  const current = out.join(''); out.length = 0;
  expect(await main(['policy', 'upgrade', '--template', 'v5', '--scope', 'scope', '--json', '--lang', locale], ctx)).toBe(0);
  expect(out.join('')).toBe(current); expect(JSON.parse(current)).toEqual(PREVIEW);
  expect(calls[0]).toEqual(calls[1]);
  expect(errors.join('')).toContain('deckent policy upgrade --template current --scope scope --preview');
  expect(errors.join('')).toContain(locale === 'en' ? 'deprecated' : 'kullanımdan kalkıyor');
});
it('says in words what the person lacks (TR), and refuses a wrong template or --expect without --apply', async () => {
  const { out, ctx } = context({ ...PREVIEW, missing: ['policy-administer', 'approval-decide', 'delegation'] });
  expect(await main(['policy', 'upgrade', '--template', 'v5', '--scope', 'scope', '--lang', 'tr'], ctx)).toBe(0);
  expect(out.join('')).toContain('Uygulama reddedilir; eksik olan:');
  expect(out.join('')).toContain('policy.administer işlemi');
  expect(await main(['policy', 'upgrade', '--template', 'v4'], ctx)).toBe(2);
  expect(await main(['policy', 'upgrade', '--template', 'v5', '--scope', 'scope', '--expect', 'x'], ctx)).toBe(2);
  expect(await main(['policy', 'upgrade', '--template', 'v5', '--scope', 'scope', '--apply', '--rollback'], ctx)).toBe(2);
});

// J3 (MON-NAMES item 3): a fresh first-run install has no upgrade to roll back; missing archive history is a refusal — neither is "not a first-run policy".
it.each([
  ['en', "Nothing to roll back: this policy is the first-run template's own version", 'Rollback refused: the earlier versions of this policy are not in the authority archive'],
  ['tr', 'Geri alınacak bir şey yok: bu politika ilk kurulum şablonunun kendi sürümü', 'Geri alma reddedildi: bu politikanın önceki sürümleri yetki arşivinde yok'],
] as const)('words a fresh-install rollback and a rollback without archived history with the next step (%s)', async (locale, fresh, refused) => {
  const installed = context({ ...PREVIEW, status: 'nothing-to-roll-back', revision: 'first-run-template-v13+first-run-template-v13-bindings', summary: null, reason: 'no-upgrade-recorded', conflicts: [] });
  expect(await main(['policy', 'upgrade', '--template', 'current', '--scope', 'scope', '--rollback', '--lang', locale], installed.ctx)).toBe(0);
  expect(installed.out.join('')).toContain(fresh); expect(installed.out.join('')).toContain('deckent policy status --scope scope');
  const missing = context({ ...PREVIEW, status: 'unavailable', revision: 'a-x+b', summary: null, reason: 'history-unavailable', conflicts: [] });
  expect(await main(['policy', 'upgrade', '--template', 'current', '--scope', 'scope', '--rollback', '--lang', locale], missing.ctx)).toBe(0);
  expect(missing.out.join('')).toContain(refused); expect(missing.out.join('')).toContain('deckent policy status --scope scope');
  for (const out of [installed.out, missing.out]) expect(out.join('')).not.toMatch(/not a first-run policy|ilk kurulum policy'si değil/u);
});


it('3286 F4: rollback preview is an explicit read in either flag order, with full EN/TR records and unchanged JSON', async () => {
  const scopes = ['scope', 'team,west', 'team\u202eabc', 'team\u200babc', 'team\\u202eabc'];
  const rules = firstRunExecutionRules([], { issuer: 'person', subject: 'one' }, scopes).wanted;
  const summary = describePolicyChange({ policy: { schemaVersion: 2, revision: 'p', roles: [], grants: rules, restrictions: [], separationOfDuties: [] },
    bindings: { schemaVersion: 3, revision: 'b', bindings: [], modes: [] } }, { schemaVersion: 1, changes: rules.map(rule => ({ kind: 'grant.remove', id: rule.id })) });
  const result = { ...PREVIEW, summary, rules, executionScopes: scopes };
  for (const locale of ['en', 'tr'] as const) for (const flags of [['--rollback', '--preview'], ['--preview', '--rollback']]) {
    const calls: unknown[] = [], { out, ctx } = context(result, calls);
    const args = ['policy', 'upgrade', '--template', 'current', '--scope', 'scope', '--lang', locale, ...flags];
    expect(await main(args, ctx)).toBe(0);
    expect(calls).toEqual([['scope', { mode: 'preview', previewRollback: true, reason: expect.any(String) }]]);
    expect(out.join('')).toContain(locale === 'en' ? 'Affected scopes (5), full list:' : 'Etkilenen kapsamlar (5), tam liste:');
    for (const shown of ['"scope"', '"team,west"', '"team\\u202eabc"', '"team\\u200babc"', '"team\\\\u202eabc"']) expect(out.join('').split('\n')).toContain(shown);
    expect(out.join('')).not.toMatch(/[\u202e\u200b]/u);
    expect(out.join('')).not.toContain('--apply');
    expect(out.join('')).not.toContain(locale === 'en' ? 'This standing grant lets AI identity' : 'Bu kalıcı izin,');
    expect(out.join('')).toContain('- grant first-run-mcp-progress-run-reserve:');
    out.length = 0;
    expect(await main([...args, '--json'], ctx)).toBe(0);
    expect(JSON.parse(out.join(''))).toEqual(result);
    expect(calls).toHaveLength(2);
  }
});

it('binds a person decision to the reviewed mixed plan and leaves automation on its original port', async () => {
  const person = { issuer: 'person', subject: 'one' }, execution = firstRunExecutionRules([], person, ['scope']).wanted;
  const template = firstRunPolicyTemplate({ scopeId: 'scope', principal: person, ...FIRST_RUN_TOOL_NAMES });
  const human = template.policy.grants.find(rule => rule.id === 'first-run-installation-repair')!;
  const summary = describePolicyChange({ policy: { schemaVersion: 2, revision: 'p', roles: [], grants: [], restrictions: [], separationOfDuties: [] },
    bindings: { schemaVersion: 2, revision: 'b', bindings: [], modes: [] } }, { schemaVersion: 1, changes: [human, ...execution].map(grant => ({ kind: 'grant.add', grant })) })!;
  const card = vi.spyOn(cards, 'askCliCard');
  try {
    for (const locale of ['en', 'tr'] as const) for (const history of ['never', 'withdrawn', 'unknown'] as const) {
      const { ctx, out } = context(PREVIEW), calls: string[] = [];
      let review = { ...PREVIEW, revision: 'r1', summary, rules: [human, ...execution], executionHistory: history };
      let revision = 'r1', status = 'preview';
      const host = { ...ctx, stdin: { isTTY: true }, stdout: { isTTY: true, write: (v: string) => out.push(v) },
        env: { ...ctx.env, ...personMarkersUnset(), TERM: 'xterm' },
        async upgradePolicyTemplate(_root: string, _scope: string, input: { mode: string; expect?: string }) {
          calls.push(input.mode);
          if (input.expect && input.expect !== revision) return { ...PREVIEW, status: 'conflict', revision };
          if (input.mode === 'preview') return { ...review, status, revision };
          revision = 'written'; return { ...review, status: 'upgraded' };
        } };
      const args = ['policy', 'upgrade', '--template', 'current', '--scope', 'scope', '--apply', '--expect', 'r1', '--lang', locale];
      const invoke = () => main(args, host as never);
      card.mockResolvedValue('not-now');
      expect(await invoke()).toBe(0); expect(calls.splice(0)).toEqual(['preview']); expect(revision).toBe('r1');
      const request = card.mock.lastCall![0], body = request.body!.join('\n');
      expect(request.initial).toBe(history === 'never' ? 'grant' : 'not-now');
      expect(request.title).toBe(locale === 'en' ? 'Apply these policy changes?' : 'Bu politika değişiklikleri uygulansın mı?');
      expect(body).toContain(locale === 'en' ? 'All scopes' : 'Tüm kapsamlar'); expect(body).toContain(summary); expect(body.indexOf(execution[0]!.id)).toBeLessThan(body.indexOf(human.id));
      expect(out.join('')).not.toMatch(/Permission kept|İzin korundu/u);
      const directory = process.env['DECKENT_I_S3_TRANSCRIPTS'];
      if (directory && history === 'never') writeFileSync(join(directory, `119-mixed-${locale}.json`), JSON.stringify(request, null, 2));
      const mixedReview = review;
      review = { ...review, rules: [...execution], summary: describePolicyChange(template, { schemaVersion: 1, changes: execution.map(grant => ({ kind: 'grant.add', grant })) })! };
      expect(await invoke()).toBe(0); expect(calls.splice(0)).toEqual(['preview']);
      const fresh = card.mock.lastCall![0];
      expect(fresh.title).toBe(locale === 'en' ? 'Let AI carry out work?' : 'Yapay zekâya işleri yürütme izni verilsin mi?');
      expect(fresh.initial).toBe(request.initial);
      if (directory && history === 'never') writeFileSync(join(directory, `119-fresh-${locale}.json`), JSON.stringify(fresh, null, 2));
      review = mixedReview;
      card.mockClear(); status = 'current';
      expect(await invoke()).toBe(0); expect(card).not.toHaveBeenCalled(); expect(revision).toBe('r1');
      status = 'preview'; revision = 'other'; calls.length = 0;
      expect(await invoke()).toBe(0); expect(card).not.toHaveBeenCalled(); expect(calls.splice(0)).toEqual(['preview']);
      revision = 'r1'; card.mockImplementationOnce(async () => { revision = 'other'; return 'grant'; });
      expect(await invoke()).toBe(0); expect(revision).toBe('other'); expect(calls.splice(0)).toEqual(['preview', 'apply']);
      revision = 'r1'; card.mockResolvedValue('grant');
      expect(await invoke()).toBe(0); expect(revision).toBe('written'); expect(calls.splice(0)).toEqual(['preview', 'apply']);
      out.length = 0; revision = 'r1'; card.mockClear();
      if (history === 'never') {
        review = { ...review, rules: [human] };
        expect(await invoke()).toBe(0); expect(calls.splice(0)).toEqual(['preview', 'apply']); expect(card).not.toHaveBeenCalled();
        revision = 'r1';
        expect(await main([...args, '--only', 'ai-proposals'], host as never)).toBe(0);
        expect(calls.splice(0)).toEqual(['apply']); expect(card).not.toHaveBeenCalled();
        revision = 'r1'; review = mixedReview; out.length = 0;
      }
      expect(await main([...args, '--json'], host as never)).toBe(0);
      expect(JSON.parse(out.join('')).status).toBe('upgraded'); expect(calls).toEqual(['apply']); expect(card).not.toHaveBeenCalled();
    }
  } finally { card.mockRestore(); }
});

it('3349 partial apply shows only the added execution authority and the whole-plan cancel hint in EN/TR', async () => {
  const person = { issuer: 'person', subject: 'one' };
  const [reserve, ...added] = firstRunExecutionRules([], person, ['scope']).wanted;
  const narrowed = { ...reserve!, resource: { ...reserve!.resource, ids: ['one-run'] } };
  const template = firstRunPolicyTemplate({ scopeId: 'scope', principal: person, ...FIRST_RUN_TOOL_NAMES });
  const human = template.policy.grants.find(rule => rule.id === 'first-run-installation-repair')!;
  const rules = [...added, human];
  const summary = describePolicyChange(template, { schemaVersion: 1, changes: rules.map(grant => ({ kind: 'grant.add', grant })) });
  const card = vi.spyOn(cards, 'askCliCard').mockResolvedValue('not-now');
  try {
    for (const locale of ['en', 'tr'] as const) {
      const calls: unknown[] = [], { ctx, out } = context({ ...PREVIEW, rules, summary, executionScopes: ['scope'], executionHistory: 'unknown',
        executionContext: [narrowed], conflicts: [narrowed.id] }, calls);
      expect(await main(['policy', 'upgrade', '--template', 'current', '--scope', 'scope', '--apply', '--lang', locale], {
        ...ctx, stdin: { isTTY: true }, stdout: { isTTY: true, write: (value: string) => out.push(value) },
        env: { ...ctx.env, ...personMarkersUnset(), TERM: 'xterm' },
      } as never)).toBe(0);
      const request = card.mock.lastCall![0], body = request.body!.join('\n');
      const directory = process.env['DECKENT_I_S3_TRANSCRIPTS'];
      if (directory) writeFileSync(join(directory, `3349-partial-${locale}.json`), JSON.stringify(request, null, 2));
      expect(body).toContain(locale === 'en' ? 'your work or another actor' : 'sizin veya başka aktörlerin işlerinde');
      expect(body).toContain(locale === 'en' ? 'Request cancellation or hold' : 'iptal isteme veya beklemeye alma');
      expect(body).toContain(locale === 'en' ? 'trigger evaluation' : 'değerlendirmeyi tetikleme');
      expect(body).not.toMatch(/reserve and start work|iş ayırma ve başlatma/u);
      expect(body).toContain(narrowed.id);
      expect(request.hints).toContain(locale === 'en' ? 'Esc/Ctrl+C cancel the whole plan without writing changes' : 'Esc/Ctrl+C hiçbir değişiklik yazmadan tüm planı iptal et');
      expect(out.join('')).toMatch(/Cancelled; nothing was written|İptal edildi; hiçbir şey yazılmadı/u);
      expect(calls).toHaveLength(1);
    }
  } finally { card.mockRestore(); }
});
