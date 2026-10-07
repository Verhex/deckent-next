import { appendFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorklineApproval, TurnDelta } from '#surfaces/core/terminal/index.js';
import { approvalCardLines, diffRows } from '#surfaces/core/terminal-work/index.js';
import { workSurfaceLabels, createWorklineLedgerPorts } from '#surfaces/core/cli/index.js';
import { span } from '#surfaces/core/terminal-render/index.js';
import { mountWorkline, settle, until, WORKLINE_TEST_LABELS } from '../support/workline-harness.js';

/**
 * T-APPROVAL-WINDOW: the labelled approval window per tool kind, EN and TR, from the real catalog; NO_COLOR keeps every meaning in text;
 * expiry, the reason field and the confirmation window decide nothing they must not. Full frames go to DECKENT_L1_FRAME_PROOF when set.
 */
const proof = (title: string, text: string) => { if (process.env.DECKENT_L1_FRAME_PROOF) appendFileSync(process.env.DECKENT_L1_FRAME_PROOF, `\n## ${title}\n${text}\n`); };
const NOW = 1_800_000_000_000;
const base = (patch: Partial<WorklineApproval>): WorklineApproval => ({ approvalId: '7a48a7f0-164d-4a2f-9353-3c3079009bec', runId: '-', taskId: '-', requester: '-', revision: 0,
  status: 'pending', decision: null, expiresAt: NOW + 272_000, summary: 'run_shell · npm test · 0123456789ab', ...patch });
const KINDS = {
  shell: { approval: base({ tool: 'run_shell', target: 'rm -rf build && npm test', risk: 'shell-destructive', summary: 'run_shell · rm -rf build && npm test · 0123456789ab' }),
    preview: '$ rm -rf build && npm test\nrisk: destructive (rm -rf)\nRuns in the bubblewrap sandbox: the project is writable, .git is read-only, no network.' },
  edit: { approval: base({ tool: 'edit_file', target: 'src/x.ts', risk: 'edit', summary: 'edit_file · src/x.ts · 0123456789ab' }),
    preview: '(+3 −1 lines)\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1,2 +1,4 @@\n-const limit = 10;\n+const limit = 20;\n+const extra = 1;\n+const more = 2;\n export {};' },
  write: { approval: base({ tool: 'write_file', target: 'docs/new.md', risk: 'edit-floor', summary: 'write_file · docs/new.md · 0123456789ab' }),
    preview: '(+2 −0 lines)\n--- /dev/null\n+++ b/docs/new.md\n@@ -0,0 +1,2 @@\n+# New\n+text' },
  fetch: { approval: base({ tool: 'fetch_url', target: 'https://example.org/page', risk: 'fetch-unlisted', summary: 'fetch_url · https://example.org/page · 0123456789ab' }),
    preview: "GET https://example.org/page\nhost: example.org (not on this installation's allowlist)\nbody: at most 1048576 bytes\nsha256(url): abc" },
  mcp: { approval: base({ tool: 'mcp__context7__query_docs', target: null, risk: 'mcp-call', summary: 'mcp__context7__query_docs · mcp:context7 · 0123456789ab' }),
    preview: 'mcp__context7__query_docs {\n  "libraryId": "/vadimdemedes/ink"\n}' },
} as const;

describe('approval window fields per tool kind (catalog EN and TR)', () => {
  for (const locale of ['en', 'tr'] as const) {
    const work = workSurfaceLabels(locale), w = work.approvalWindow;
    for (const [kind, fixture] of Object.entries(KINDS)) {
      it(`${locale} ${kind}: nine labelled fields, human risk and rule, digest only in the details`, () => {
        const lines = approvalCardLines(fixture.approval, work, fixture.preview, kind === 'shell' ? 'rm -rf build && npm test' : null, { project: '/home/u/acme', mode: 'standart' }, NOW);
        const text = lines.join('\n');
        proof(`model ${locale} ${kind}`, text);
        for (const field of ['what', 'where', 'onBehalf', 'scope', 'why', 'risk', 'undo', 'time'] as const) expect(text).toContain(w.field[field]);
        const value = kind === 'shell' ? w.field.command : kind === 'fetch' ? w.field.address : kind === 'mcp' ? null : w.field.file;
        if (value) expect(text).toContain(value);
        expect(text).toContain('4:32');
        expect(text).toContain(w.rule[fixture.approval.risk!]!); expect(text).toContain(w.risk[fixture.approval.risk!]!);
        expect(text).toContain(w.mode['standart']!);
        // Raw codes stay out of the primary rows: the digest and the policy cell appear only after the details heading.
        const details = lines.indexOf(w.field.detail);
        expect(details).toBeGreaterThan(0);
        // (A hyphenated cell is a code; `edit` is also an ordinary word, so only codes are checked.)
        lines.forEach((line, index) => { if (index < details) { expect(line).not.toContain('0123456789ab'); if (fixture.approval.risk!.includes('-')) expect(line).not.toContain(fixture.approval.risk!); } });
        expect(lines.slice(details).join('\n')).toContain('0123456789ab');
      });
    }
  }

  it('names the careful mode (the status row\'s ask-edits stop) under why asked, EN and TR (T2 integration)', () => {
    for (const [locale, words] of [['en', 'Mode: careful (edits ask too)'], ['tr', 'Mod: dikkatli (düzenlemeler de sorulur)']] as const) {
      const text = approvalCardLines(KINDS.edit.approval, workSurfaceLabels(locale), KINDS.edit.preview, null, { project: '/home/u/acme', mode: 'ask-edits' }, NOW).join('\n');
      expect(text).toContain(words);
    }
  });

  it('shell: the full command (not the 200-character call line), the realm sentence under where, the session scope sentence', () => {
    const w = workSurfaceLabels('tr').approvalWindow;
    const text = approvalCardLines(KINDS.shell.approval, workSurfaceLabels('tr'), KINDS.shell.preview, 'rm -rf build && npm test', {}, NOW).join('\n');
    expect(text).toContain('Kabuk komutu çalıştırılacak'); expect(text).toContain('rm -rf build && npm test');
    expect(text).toContain('bubblewrap'); expect(text).toContain('Silme içeriyor (geri alınamaz)');
    expect(text).toContain('Kural: silme içeren kabuk komutları her zaman onay ister · Mod: bilinmiyor');
    expect(text).toContain('4:32 içinde karar verilmezse hiçbir şey çalışmaz');
    expect(text).toContain(w.whereUnknown);
  });

  it('a cut preview says so in the catalog words; the engine marker and sha256 stay out of the primary rows', () => {
    const work = workSurfaceLabels('en'), digest = 'a'.repeat(64);
    const cut = `[Deckent: preview cut to 2 of 900 lines (120 of 90000 bytes); whole text sha256 ${digest}; complete at /data/approval-previews/x.txt]\n(+900 −0 lines)\n+one\n+two`;
    const lines = approvalCardLines(base({ tool: 'write_file', target: 'big.txt', risk: 'edit' }), work, cut, null, {}, NOW);
    expect(lines).toContain('Preview shortened: the first 2 of 900 lines (120 of 90000 bytes)');
    expect(lines.join('\n')).not.toContain('[Deckent:');
    const details = lines.indexOf('Details');
    expect(lines.findIndex(line => line.includes(digest))).toBeGreaterThan(details);
    expect(lines.join('\n')).toContain('Complete text kept at: /data/approval-previews/x.txt');
  });

  it('word-level diff: the changed middle of a removed/added pair is bold, the +/- text stays for NO_COLOR', () => {
    const rows = diffRows([{ spans: [span('-const limit = 10;')], fields: [] }, { spans: [span('+const limit = 20;')], fields: [] }, { spans: [span(' same')], fields: [] }]);
    const bold = (index: number) => rows[index]!.spans.filter(part => part.bold).map(part => part.text).join('');
    expect(bold(0)).toBe('1'); expect(bold(1)).toBe('2');
    expect(rows[0]!.spans.map(part => part.text).join('')).toBe('-const limit = 10;');
    expect(rows[0]!.spans.every(part => part.role === 'diffRemoved')).toBe(true); expect(rows[1]!.spans.every(part => part.role === 'diffAdded')).toBe(true);
    expect(rows[2]!.spans.every(part => part.role === undefined)).toBe(true);
  });
});

describe('approval window in the real Workline', () => {
  const mounted: Array<{ unmount(): void }> = [];
  afterEach(() => { for (const instance of mounted.splice(0)) instance.unmount(); });
  const turn = (patch: Partial<Extract<TurnDelta, { kind: 'approval'; phase: 'requested' }>>, hold: Promise<void>) => async function* () {
    yield { kind: 'tool' as const, phase: 'started' as const, callId: 'c1', name: 'run_shell', target: 'rm -rf build', status: null, ms: null };
    yield { kind: 'approval' as const, phase: 'requested' as const, callId: 'c1', approvalId: 'appr-w', revision: 0, summary: 'run_shell · rm -rf build · 0123456789ab',
      preview: '$ rm -rf build\nrisk: destructive (rm)\nRuns on this machine as your user.', expiresAt: Date.now() + 600_000, risk: 'shell-destructive',
      tool: 'run_shell', target: 'rm -rf build', ...patch };
    await hold;
    yield { kind: 'done' as const, finish: 'stop' as const };
  };
  const port = (calls: unknown[][]) => ({ scopeId: 'scope-a', async listWorkers() { return { schemaVersion: 1, scopeId: 'scope-a', sources: [] } as never; }, async inspectRun() { return null; },
    async decideApproval(approval: { approvalId: string }, decision: string, standing?: string, reason?: string) {
      calls.push([approval.approvalId, decision, standing, reason]);
      return { approvalId: approval.approvalId, runId: '-', taskId: '-', summary: '', requester: '-', revision: 1, status: 'decided' as const, decision, expiresAt: 0 };
    } });

  for (const locale of ['en', 'tr'] as const) {
    it(`${locale}, NO_COLOR, 40 columns: every row fits, labels carry the meaning without colour, no escape colour codes`, async () => {
      let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
      const labels = { ...WORKLINE_TEST_LABELS, work: workSurfaceLabels(locale) }, w = labels.work.approvalWindow;
      const view = mountWorkline({ labels, streamTurn: turn({}, hold) as never, ledger: port([]) as never, projectRoot: '/home/u/acme' }, 40);
      mounted.push(view.instance);
      await settle(20); for (const char of 'go\r') { view.stdin.write(char); await settle(2); }
      await until(() => view.stdout.frame.includes(w.field.what), 'approval window');
      await settle(40);
      const frame = view.stdout.frame;
      proof(`workline ${locale} NO_COLOR 40 columns`, frame);
      for (const row of frame.split('\n')) expect([...row].length).toBeLessThanOrEqual(40);
      expect(frame.includes('\u001B[3')).toBe(false); expect(frame.includes('\u001B[9')).toBe(false);
      expect(frame).toContain(w.field.risk); expect(frame).toContain(w.risk['shell-destructive']!.slice(0, 12));
      expect(frame).toContain('rm -rf build');
      release();
    });
  }

  it('a window leaves room for a visible worker panel: the whole live area stays within the terminal rows', async () => {
    let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
    const labels = { ...WORKLINE_TEST_LABELS, work: workSurfaceLabels('en') };
    const identity = (attemptId: string) => ({ scopeId: 'scope-a', runId: 'r', taskId: `t-${attemptId}`, attemptId, generation: 1, layoutRevision: 'l' });
    const report = () => ({ schemaVersion: 1, observedAt: Date.now(), scopeId: 'scope-a', control: 'observe-only', sources: [{ workers: Array.from({ length: 10 }, (_, index) =>
      ({ taskId: `t-${index}`, identity: identity(`a${index}`), provider: 'claude', process: 'running', authority: 'next-ledger', files: null })) }] });
    const ledger = { ...port([]), async listWorkers() { return report() as never; } };
    const view = mountWorkline({ labels, streamTurn: turn({ preview: `$ ${'x '.repeat(10)}\nrisk: destructive (rm)\n${Array.from({ length: 30 }, (_, i) => `posture ${i}`).join('\n')}` }, hold) as never,
      ledger: ledger as never, pollMs: 40 }, 120, { rows: 30 });
    mounted.push(view.instance);
    for (const char of '/watch-workers\r') { view.stdin.write(char); await settle(2); }
    await until(() => view.stdout.frame.includes('+2'), 'worker panel with more');
    for (const char of 'go\r') { view.stdin.write(char); await settle(2); }
    await until(() => view.stdout.frame.includes('What:'), 'approval window'); await settle(80);
    const frame = view.stdout.frame;
    proof('workline en 30 rows with worker panel', frame);
    expect(frame).toMatch(/rows 1–\d+ of \d+/u);
    // Everything below the scrollback (worker panel, window, status, composer) fits the 30-row terminal.
    const live = frame.slice(frame.indexOf(labels.work.panel.title));
    expect(live.split('\n').filter(Boolean).length).toBeLessThanOrEqual(30);
    release();
  });

  it('/approvals rows with the catalog: what, who and how long; no approval id on the row', async () => {
    const now = Date.now();
    const items = [base({ approvalId: 'b8f1c2d3-0000-4000-8000-000000000001', tool: 'run_shell', target: 'npm test', requester: 'alperen@host', createdAt: now - 125_000, expiresAt: now + 600_000 }),
      base({ approvalId: 'b8f1c2d3-0000-4000-8000-000000000002', summary: 'Deploy the release', runId: 'run-1', taskId: 'task-1', requester: 'svc@host', expiresAt: now + 600_000 })];
    for (const locale of ['en', 'tr'] as const) {
      const labels = { ...WORKLINE_TEST_LABELS, work: workSurfaceLabels(locale) };
      const view = mountWorkline({ labels, pollMs: 10_000, ledger: { ...port([]), async listApprovalPage() { return { items, nextAfter: null }; } } as never }, 160);
      mounted.push(view.instance);
      for (const char of '/approvals\r') { view.stdin.write(char); await settle(2); }
      await until(() => view.stdout.frame.includes(labels.work.window.approvalsTitle), `approvals window ${locale}`); await settle(40);
      const frame = view.stdout.frame;
      proof(`approvals list ${locale}`, frame);
      expect(frame).toContain(locale === 'en' ? '1. A shell command will run: npm test · requested by alperen@host · waiting 2' : '1. Kabuk komutu çalıştırılacak: npm test · isteyen alperen@host · 2');
      expect(frame).toContain(locale === 'en' ? '2. Deploy the release · requested by svc@host · waiting an unknown time' : '2. Deploy the release · isteyen svc@host · bilinmeyen bir süredir bekliyor');
      expect(frame).not.toContain('b8f1c2d3');
      view.stdin.write('\u001B'); await settle(40);
    }
  });

  it('after expiry the window says nothing ran and y decides nothing', async () => {
    const calls: unknown[][] = [];
    let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
    const labels = { ...WORKLINE_TEST_LABELS, work: workSurfaceLabels('en') };
    const view = mountWorkline({ labels, streamTurn: turn({ expiresAt: Date.now() + 1_300 }, hold) as never, ledger: port(calls) as never });
    mounted.push(view.instance);
    await settle(20); for (const char of 'go\r') { view.stdin.write(char); await settle(2); }
    await until(() => view.stdout.frame.includes('Time is up — nothing ran'), 'expired window', 400);
    view.stdin.write('y'); await settle(80); view.stdin.write('\r'); await settle(80);
    expect(calls).toEqual([]);
    release();
  });

  it('Tab writes a reason (a typed y there is text, not a decision); the decision carries it to the port', async () => {
    const calls: unknown[][] = [];
    let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
    const labels = { ...WORKLINE_TEST_LABELS, work: workSurfaceLabels('en') };
    const view = mountWorkline({ labels, streamTurn: turn({}, hold) as never, ledger: port(calls) as never });
    mounted.push(view.instance);
    await settle(20); for (const char of 'go\r') { view.stdin.write(char); await settle(2); }
    await until(() => view.stdout.frame.includes('Tab reason'), 'window'); await settle(40);
    view.stdin.write('\t'); await until(() => view.stdout.frame.includes('Reason:'), 'reason field');
    for (const char of 'yes, the build dir is stale') { view.stdin.write(char); await settle(2); }
    await settle(40);
    expect(calls).toEqual([]);
    view.stdin.write('\r'); await settle(40);
    expect(calls).toEqual([]);
    view.stdin.write('n');
    await until(() => calls.length === 1, 'decided');
    expect(calls).toEqual([['appr-w', 'deny', undefined, 'yes, the build dir is stale']]);
    release();
  });

  it('/service-restart asks first: n, Enter and Esc keep the service; y restarts it once', async () => {
    let restarts = 0;
    const labels = { ...WORKLINE_TEST_LABELS, work: workSurfaceLabels('en') };
    const view = mountWorkline({ labels, restartService: async () => { restarts++; return 'RESTARTED'; } });
    mounted.push(view.instance);
    const type = async (text: string) => { for (const char of text) { view.stdin.write(char); await settle(2); } };
    for (const key of ['n', '\r', '\u001B']) {
      await type('/service-restart\r');
      await until(() => view.stdout.frame.includes('Restart the runtime service?'), 'confirm window'); await settle(40);
      view.stdin.write(key);
      await until(() => !view.stdout.frame.includes('Restart the runtime service?'), 'closed');
    }
    expect(restarts).toBe(0);
    expect(view.stdout.text).toContain('Service restart cancelled; nothing changed.');
    await type('/service-restart\r');
    await until(() => view.stdout.frame.includes('Restart the runtime service?'), 'confirm window'); await settle(40);
    view.stdin.write('y');
    await until(() => view.stdout.text.includes('RESTARTED'), 'restarted');
    expect(restarts).toBe(1);
  });
});

describe('the decision reason reaches the decision command', () => {
  it('a typed reason replaces the default sentence; none keeps it', async () => {
    const sent: Record<string, unknown>[] = [];
    const ports = createWorklineLedgerPorts({ root: '/tmp/x', scopeId: 'scope-a', options: {} as never, locale: 'en',
      inspectWorkers: (async () => ({})) as never, inspectRun: (async () => ({ run: null })) as never, listApprovals: async () => [],
      decideApproval: async (input: unknown) => { sent.push(input as Record<string, unknown>); throw new Error('stop'); } })!;
    await ports.decideApproval!({ approvalId: 'a', revision: 0 }, 'deny', undefined, '  stale build  ').catch(() => undefined);
    await ports.decideApproval!({ approvalId: 'a', revision: 0 }, 'deny').catch(() => undefined);
    expect(sent.map(item => item['reason'])).toEqual(['stale build', 'Denied by the operator in the Deckent terminal.']);
  });
});
