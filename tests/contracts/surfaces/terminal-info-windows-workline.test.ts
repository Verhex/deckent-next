import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { registerProviderConfig } from '#adapters/index.js';
import { clearConfigCache, ErrorRegistry, PACKAGE_VERSION } from '#platform/index.js';
import { terminalAdminPorts, type TerminalAdminContext } from '#surfaces/core/terminal-admin/index.js';
import { terminalComposerLabels } from '#surfaces/core/terminal-labels/index.js';
import { EMPTY_SESSION_USAGE, WORKLINE_SLASH_COMMANDS } from '#surfaces/core/terminal-kit/index.js';
import { infoModelText, type InfoSurfaceLabels } from '#surfaces/core/terminal-window/index.js';
import type { WorklineProps } from '#surfaces/core/terminal/index.js';
import { mountWorkline, settle, until, WORKLINE_TEST_LABELS } from '../support/workline-harness.js';

// SW-1 (owner 2026-10-08): bare /help /status /usage /doctor /scope /context open information windows on the real workline. Nothing reaches the
// chat stream while they are open; on close exactly one framed system summary line stays; identities are never the primary label.
const ESC = '\u001B', DOWN = '\u001B[B';
const INSTALLATION = '7d1e2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b', PROJECT = '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d', COMMIT = '3f9a2c71e4b8d0aa55c1e2f3a4b5c6d7e8f90123';
const MARK = '◆ Deckent system';
const roots: string[] = [], views: Array<ReturnType<typeof mountWorkline>> = [];
afterEach(async () => { for (const view of views.splice(0)) view.instance.unmount(); clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const count = (text: string, part: string) => text.split(part).length - 1;
async function type(view: ReturnType<typeof mountWorkline>, text: string) { for (const char of text) { view.stdin.write(char); await settle(2); } }
async function project(config: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dn-sw1-')); roots.push(root);
  await mkdir(join(root, '.deckent'), { recursive: true });
  await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'd') }, ...config }));
  return root;
}
function admin(root: string, context: TerminalAdminContext, extra: Partial<Parameters<typeof terminalAdminPorts>[0]> = {}) {
  return terminalAdminPorts({ root, scopeId: 's', installationId: INSTALLATION, projectId: PROJECT, options: { env: { HOME: join(root, 'h') } }, locale: 'en', context,
    status: async () => 'Terminal: stdin yes', doctor: async sink => { sink.write('DOCTOR-TEXT-1\nDOCTOR-TEXT-2\n'); }, principalName: 'alperen', ...extra });
}
async function open(props: Partial<WorklineProps>) {
  const view = mountWorkline({ ...props, labels: { ...WORKLINE_TEST_LABELS, composer: { ...WORKLINE_TEST_LABELS.composer, slash: terminalComposerLabels('en').slash } } });
  views.push(view);
  await until(() => view.stdout.frame.includes('READY'), 'workline ready');
  return view;
}
const running: TerminalAdminContext = { describeRuntimeService: async () => ({ instanceId: '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b', processId: 4242, build: { sourceCommit: COMMIT } }),
  describeTerminalChatPlan: async () => ({ status: 'ready', reference: { providerId: 'claude', providerVersion: 1, modelId: 'opus-5-5', modelVersion: 1 } as never }) };

describe('information windows on the real workline (SW-1)', () => {
  it('/status opens a window, holds the composer, and leaves exactly one system summary line on Esc', async () => {
    const root = await project();
    const view = await open({ info: admin(root, running).info });
    await type(view, '/status\r');
    await until(() => view.stdout.frame.includes('▸ Runtime service'), 'status window');
    const window = view.stdout.frame;
    expect(window).toContain('[✓ running]'); expect(window).toContain('pid 4242'); expect(window).toContain('current instance 5e6f7a8b…');
    expect(window).toContain('source commit 3f9a2c71…'); expect(window).not.toContain(COMMIT); expect(window).not.toContain(INSTALLATION);
    expect(window).toMatch(new RegExp(`│ Version +${PACKAGE_VERSION.replace(/\./gu, '\\.')} `, 'u')); expect(count(window, MARK)).toBe(0);
    // Negative: a line typed while the window is open never reaches the chat (the window owns the keyboard; Enter closes it).
    await type(view, 'hello\r');
    await until(() => view.stdout.frame.includes(MARK), 'summary line');
    await settle(40);
    const after = view.stdout.frame;
    expect(count(after, MARK)).toBe(1);
    expect(after).toContain(`${MARK} · Status: Deckent is running · ${PACKAGE_VERSION}`);
    for (const body of ['▸ Runtime service', 'current instance', 'pid 4242', 'Terminal: stdin yes', 'Info:']) expect(after, body).not.toContain(body);
    expect(after).not.toMatch(/\byou\b[\s\S]*hello/u);
    await type(view, '/status\r'); await until(() => view.stdout.frame.includes('▸ Runtime service'), 'status again');
    await type(view, ESC); await until(() => count(view.stdout.frame, MARK) === 2, 'second summary');
  });

  it('/help lists the commands by group; Enter runs the highlighted command (no typed argument), Esc leaves the help summary', async () => {
    const root = await project();
    const view = await open({ info: admin(root, running).info });
    await type(view, '/help\r');
    await until(() => view.stdout.frame.includes('› /status'), 'help window');
    expect(view.stdout.frame).toContain('▸ Info'); expect(view.stdout.frame).toContain('Enter opens');
    await type(view, ESC);
    await until(() => view.stdout.frame.includes(`${MARK} · Help: ${WORKLINE_SLASH_COMMANDS.length} commands`), 'help summary');
    await type(view, '/help\r'); await until(() => view.stdout.frame.includes('› /status'), 'help again');
    await type(view, DOWN); await until(() => view.stdout.frame.includes('› /context'), 'second row');
    await type(view, '\r');
    await until(() => view.stdout.frame.includes('▸ Window'), 'context window opened from help');
    await type(view, 'q');
    await until(() => view.stdout.frame.includes(`${MARK} · Context: not measured yet · 0 messages`), 'context summary');
    // The help window that ran a command leaves no line of its own: one help summary (the first Esc) and one context summary.
    expect(count(view.stdout.frame, MARK)).toBe(2);
  });

  it('/usage picks a budget from the scope configuration (no typed id or revision) and reads its account through the typed query', async () => {
    registerProviderConfig();
    const root = await project({ provider_spending: { schemaVersion: 1, budgets: [{ schemaVersion: 1, scopeId: 's', budgetId: 'team-budget', revision: 3, currency: 'USD', limitMinorUnits: 50000 }] } });
    const calls: unknown[] = [];
    const context: TerminalAdminContext = { inspectProviderSpendAccount: (async (_root: string, query: unknown) => { calls.push(query);
      return { schemaVersion: 2, scopeId: 's', budgetId: 'team-budget', budgetRevision: 3, checkpoint: null, audit: null, spendingHistoryIntegrity: 'not-recorded' }; }) as never };
    const view = await open({ info: admin(root, context).info });
    await type(view, '/usage\r');
    await until(() => view.stdout.frame.includes('› team-budget · limit 50,000 minor units (USD)'), 'budget choice');
    expect(view.stdout.frame).toContain('No token usage reported yet');
    await type(view, '\r');
    await until(() => view.stdout.frame.includes('▸ Spend account · team-budget [! no snapshot]'), 'account section');
    expect(calls).toEqual([{ schemaVersion: 1, scopeId: 's', budgetId: 'team-budget', budgetRevision: 3 }]);
    await type(view, ESC);
    await until(() => view.stdout.frame.includes(`${MARK} · Usage: nothing reported yet in this conversation`), 'usage summary');
    expect(count(view.stdout.frame, MARK)).toBe(1);
  });

  it('/doctor groups the structured doctor report by area with chips; without it the doctor text is one section', async () => {
    const root = await project();
    const report = { schemaVersion: 2, scope: 'kernel', platform: 'linux', status: 'ready', host: { cpuCores: 8, totalMemMB: 16000, recommendedMaxWorkers: 4 },
      company: { companyId: 'default' }, principal: { id: 'host:1000' }, secretStore: { backend: 'core.secret-store.encrypted-file@1', status: 'ready', code: null },
      serviceConfig: 'stale', imageRefresh: { status: 'failed', reason: 'network', imageVersion: null }, installationBinding: { capability: 'supported', strength: 'machine', source: 'platform' },
      poolReadiness: { status: 'ready', drift: null }, shellRealm: null };
    const ports = admin(root, {}, { doctorReport: async sink => { sink.write(`${JSON.stringify({ message: 'a config warning' })}\n${JSON.stringify(report)}\n`); } });
    const view = await open({ info: ports.info });
    await type(view, '/doctor\r');
    await until(() => view.stdout.frame.includes('▸ Worker image [✗ failed]'), 'doctor window');
    const frame = view.stdout.frame;
    expect(frame).toContain('[✓ 3 ok] [! 1 check] [✗ 1 failed]'); expect(frame).toContain('▸ Secret store [✓ ok]'); expect(frame).toContain('▸ Runtime service [! check]');
    expect(frame).toContain('Memory'); expect(frame).toContain('16000 MB');
    await type(view, ESC);
    await until(() => view.stdout.frame.includes(`${MARK} · Health: 3 ok · 1 to check · 1 failed`), 'doctor summary');
    const text = (await admin(root, {}).info.ports.doctor!({ usage: EMPTY_SESSION_USAGE })).model;
    expect(infoModelText(text)).toEqual(expect.arrayContaining(['  - DOCTOR-TEXT-1', 'The structured report could not be read; this is the doctor text.']));
  });

  it('/scope shows human labels with identities muted after them, and names a part it could not read', async () => {
    const root = await project();
    const context: TerminalAdminContext = { inspectPermissionMode: async () => { throw ErrorRegistry.createError('POLICY_DENIED' as never); },
      inspectSurfaceAccess: async () => ({ binding: 'b', kinds: ['run', 'worker'] }) };
    const model = (await admin(root, context).info.ports.scope!({ usage: EMPTY_SESSION_USAGE })).model;
    const text = infoModelText(model);
    expect(text).toEqual(expect.arrayContaining(['Installation   this installation 7d1e2c3b...', 'Project        project identity 0a1b2c3d...', 'Surface access runs, workers']));
    expect(text.find(line => line.startsWith('Mode'))).toMatch(/Permission mode: not read.*POLICY_DENIED.*\[x not read\]/u);
    expect(text.join('\n')).not.toContain(INSTALLATION);
    // No row of any window starts with an identity: the key column is a word.
    for (const line of text) expect(line).not.toMatch(/^[0-9a-f]{8}/u);
  });

  it('/context opens the window from the measured turn; typed arguments of /usage keep the text answer', async () => {
    const root = await project();
    const streamTurn = async function* () {
      yield { kind: 'context' as const, round: 1, promptTokens: 4_000, windowTokens: 5_000, quality: 'provider-count' as const };
      yield { kind: 'text' as const, text: 'ok' }; yield { kind: 'done' as const, finish: 'stop' as const, note: null };
    };
    const ports = admin(root, {});
    const view = await open({ info: ports.info, inspect: ports.inspect, streamTurn: streamTurn as never, sessions: { async save() {}, async list() { return []; }, async load() { return null; } },
      labels: { ...WORKLINE_TEST_LABELS, composer: { ...WORKLINE_TEST_LABELS.composer, slash: terminalComposerLabels('en').slash } } });
    await type(view, 'go\r'); await until(() => view.stdout.frame.includes('ok'), 'turn');
    await settle(40);
    await type(view, '/context\r');
    await until(() => view.stdout.frame.includes('▸ Window [! filling up]'), 'context window');
    expect(view.stdout.frame).toContain('80%'); expect(view.stdout.frame).toContain('4000 of 5000 tokens');
    await type(view, ESC);
    await until(() => view.stdout.frame.includes(`${MARK} · Context: 80% full · 2 messages`), 'context summary');
    await type(view, '/usage b1 2\r');
    await until(() => view.stdout.frame.includes('Provider spend account: not available'), 'typed /usage keeps the text command');
  });
});

describe('information window words (SW-1)', () => {
  it('carries every catalog word in both languages', () => {
    const ports = (locale: 'en' | 'tr'): InfoSurfaceLabels => terminalAdminPorts({ root: '/x', scopeId: 's', installationId: 'i', projectId: 'p', options: {}, locale, context: {},
      status: async () => '', doctor: async () => undefined }).info.labels;
    for (const locale of ['en', 'tr'] as const) {
      const words = JSON.stringify(ports(locale));
      expect(words).not.toMatch(/"terminal\.info\./u);
    }
    expect(ports('tr').systemLabel).toBe('Deckent sistemi');
  });
});
