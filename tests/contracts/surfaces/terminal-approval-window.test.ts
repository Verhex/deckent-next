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
  shell: { approval: base({ tool: 'run_shell', target: 'rm -rf build && npm test', risk: 'shell-destructive', summary: 'run_shell · rm -rf build && npm test · 0123456789ab',
    call: { kind: 'shell', command: 'rm -rf build && npm test', tier: 'destructive', reason: 'rm -rf' },
    posture: { realm: 'bubblewrap', containment: 'sandbox', project: 'writable', git: 'read-only', network: 'closed', passedOver: [] } }),
    preview: '$ rm -rf build && npm test\nrisk: destructive (rm -rf)\nRuns in the bubblewrap sandbox: the project is writable, .git is read-only, no network.' },
  edit: { approval: base({ tool: 'edit_file', target: 'src/x.ts', risk: 'edit', summary: 'edit_file · src/x.ts · 0123456789ab', call: { kind: 'edit', path: 'src/x.ts', added: 3, removed: 1 } }),
    preview: '(+3 −1 lines)\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1,2 +1,4 @@\n-const limit = 10;\n+const limit = 20;\n+const extra = 1;\n+const more = 2;\n export {};' },
  write: { approval: base({ tool: 'write_file', target: 'docs/new.md', risk: 'edit-floor', summary: 'write_file · docs/new.md · 0123456789ab', call: { kind: 'edit', path: 'docs/new.md', added: 2, removed: 0 } }),
    preview: '(+2 −0 lines)\n--- /dev/null\n+++ b/docs/new.md\n@@ -0,0 +1,2 @@\n+# New\n+text' },
  fetch: { approval: base({ tool: 'fetch_url', target: 'https://example.org/page', risk: 'fetch-unlisted', summary: 'fetch_url · https://example.org/page · 0123456789ab',
    call: { kind: 'fetch', url: 'https://example.org/page', host: 'example.org', listed: false } }),
    preview: "GET https://example.org/page\nhost: example.org (not on this installation's allowlist)\nbody: at most 1048576 bytes\nsha256(url): abc" },
  mcp: { approval: base({ tool: 'mcp__context7__query_docs', target: null, risk: 'mcp-call', summary: 'mcp__context7__query_docs · mcp:context7 · 0123456789ab',
    call: { kind: 'mcp', server: 'context7', tool: 'query_docs' } }),
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

  // L1 MCP-CORE item 6 (Astra 2435 P2): a hyphenated server's wire name (`docs-search` → `mcp__docs_search__…`) is an MCP tool, titled with its
  // real server name; the separator is the first `__` after the server, so a tool name with `_` stays whole.
  it('titles a hyphenated server\'s MCP tool as MCP with the server name restored (EN and TR)', () => {
    for (const locale of ['en', 'tr'] as const) {
      const work = workSurfaceLabels(locale), w = work.approvalWindow;
      const what = (tool: string) => approvalCardLines(base({ tool, target: null, risk: 'mcp-call', summary: `${tool} · mcp:x · 0123456789ab` }), work, `${tool} {}`, null, {}, NOW)
        .find(line => line.startsWith(w.field.what))!;
      const hyphenated = what('mcp__docs_search__query_docs');
      expect(hyphenated).toContain('query_docs'); expect(hyphenated).toContain('docs-search'); expect(hyphenated).not.toContain('mcp__docs_search__query_docs');
      expect(hyphenated).toBe(what('mcp__context7__query_docs').replace('context7', 'docs-search'));
      expect(what('mcp__a__b_c')).toBe(what('mcp__context7__query_docs').replace('context7', 'a').replace('query_docs', 'b_c'));
      expect(what('mcp__a_b__x')).toBe(what('mcp__context7__query_docs').replace('context7', 'a-b').replace('query_docs', 'x'));
    }
  });

  it('names the careful mode (the status row\'s ask-edits stop) under why asked, EN and TR (T2 integration)', () => {
    for (const [locale, words] of [['en', 'Mode: careful (edits ask too)'], ['tr', 'Mod: dikkatli (düzenlemeler de sorulur)']] as const) {
      const text = approvalCardLines(KINDS.edit.approval, workSurfaceLabels(locale), KINDS.edit.preview, null, { project: '/home/u/acme', mode: 'ask-edits' }, NOW).join('\n');
      expect(text).toContain(words);
    }
  });

  it('shell: the full command (not the 200-character call line), the structured posture under where (never the engine sentence), the session scope sentence', () => {
    const w = workSurfaceLabels('tr').approvalWindow;
    const text = approvalCardLines(KINDS.shell.approval, workSurfaceLabels('tr'), KINDS.shell.preview, 'rm -rf build && npm test', {}, NOW).join('\n');
    expect(text).toContain('Kabuk komutu çalıştırılacak'); expect(text).toContain('rm -rf build && npm test');
    expect(text).toContain('bubblewrap sandbox içinde: proje yazılabilir (korunan dosyalar dahil), .git salt okunur, ağ kapalı'); expect(text).toContain('Silme içeriyor (geri alınamaz)');
    // The engine's English posture sentence is never parsed into a field; it stays only in the producer's preview, shown whole (Astra 2431).
    const lines = text.split('\n'), preview = lines.indexOf('Önizleme');
    expect(lines.findIndex(line => line.includes('Runs in the bubblewrap sandbox'))).toBeGreaterThan(preview);
    expect(preview).toBeGreaterThan(0);
    expect(text).toContain('Hayır — geri alınamaz');
    expect(text).toContain('Kural: silme içeren kabuk komutları her zaman onay ister · Mod: bilinmiyor');
    expect(text).toContain('4:32 içinde karar verilmezse hiçbir şey çalışmaz');
    expect(text).toContain(w.whereUnknown);
  });

  it('a cut preview says so in the catalog words; the engine marker and sha256 stay out of the primary rows', () => {
    const work = workSurfaceLabels('en'), digest = 'a'.repeat(64);
    const cut = `[Deckent: preview cut to 2 of 900 lines (120 of 90000 bytes); whole text sha256 ${digest}; complete at /data/approval-previews/x.txt]\n(+900 −0 lines)\n+one\n+two`;
    const lines = approvalCardLines(base({ tool: 'write_file', target: 'big.txt', risk: 'edit', call: { kind: 'edit', path: 'big.txt', added: 900, removed: 0 },
      previewCut: { shown: 2, total: 900, bytes: 120, totalBytes: 90000, digest, kept: '/data/approval-previews/x.txt' } }), work, cut, null, {}, NOW);
    expect(lines).toContain('Preview shortened: the first 2 of 900 lines (120 of 90000 bytes)');
    // The facts come from the event, not from the marker line; the marker stays in the producer's preview, which is shown whole.
    expect(lines.findIndex(line => line.includes('[Deckent:'))).toBeGreaterThan(lines.indexOf('Preview'));
    const details = lines.indexOf('Details');
    // The digest is not in the primary rows; it is named in the details (and stays inside the producer's marker line in the preview).
    expect(lines.findIndex(line => line.includes(digest))).toBeGreaterThan(lines.indexOf('Preview'));
    expect(lines.slice(details).some(line => line.includes(digest))).toBe(true);
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

  it('an approval window takes the screen from an open watch window (one visible window), fits the terminal rows, and the watch window returns after the decision (T3 L5)', async () => {
    let releaseA!: () => void, releaseB!: () => void;
    const gateA = new Promise<void>(resolve => { releaseA = resolve; }), holdB = new Promise<void>(resolve => { releaseB = resolve; });
    let started = 0;
    const streamTurn = () => {
      started++;
      return started === 1 ? (async function* () { await gateA; yield { kind: 'done' as const, finish: 'stop' as const }; })()
        : turn({ preview: `$ ${'x '.repeat(10)}\nrisk: destructive (rm)\n${Array.from({ length: 30 }, (_, i) => `posture ${i}`).join('\n')}` }, holdB)();
    };
    const work = workSurfaceLabels('en'), labels = { ...WORKLINE_TEST_LABELS, work };
    const calls: unknown[][] = [];
    const view = mountWorkline({ labels, streamTurn: streamTurn as never, ledger: { ...port(calls), async listWorkers() { return { schemaVersion: 1, observedAt: Date.now(), scopeId: 'scope-a', control: 'observe-only',
      sources: [{ workers: Array.from({ length: 10 }, (_, index) => ({ taskId: `t-${index}`, provider: 'claude', process: 'running', authority: 'next-ledger', files: null })) }] } as never; } } as never, pollMs: 40 }, 120, { rows: 30 });
    mounted.push(view.instance);
    await settle(20);
    // Turn one is busy; the watch command and the second turn queue behind it. When turn one ends the watch window opens and turn two asks for approval over it.
    for (const line of ['one', '/watch-workers', 'two']) { for (const char of `${line}\r`) { view.stdin.write(char); await settle(2); } }
    releaseA();
    await until(() => view.stdout.frame.includes('What:'), 'approval window over the watch window'); await settle(80);
    const frame = view.stdout.frame;
    proof('workline en 30 rows, approval over a watch window', frame);
    expect(frame).not.toContain(work.live!.hints); // the watch window steps aside while the approval window is up
    expect(frame).toMatch(/rows 1–\d+ of \d+/u);
    const live = frame.slice(frame.indexOf('What:') - 400);
    expect(live.split('\n').filter(Boolean).length).toBeLessThanOrEqual(30);
    view.stdin.write('\u001B'); // Esc denies
    await until(() => calls.length === 1, 'decision reached the port'); releaseB();
    await until(() => view.stdout.frame.includes(work.live!.hints), 'the watch window is back after the decision');
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

// T2-FOLLOWUP REVERSIBILITY (owner 2026-10-07, Jev 8cc5e230) and POSTURE (L1 D2/D4): the "can it be undone" field is filled by what the call
// is, cautiously and never "reversible" without evidence; a shell call's posture is worded from structured facts, EN and TR.
describe('approval window: reversibility by call kind and structured posture (T2-FOLLOWUP)', () => {
  const undoOf = (approval: WorklineApproval, locale: 'en' | 'tr') => {
    const w = workSurfaceLabels(locale).approvalWindow;
    const row = approvalCardLines(approval, workSurfaceLabels(locale), undefined, null, {}, NOW).find(line => line.startsWith(w.field.undo))!;
    return row.slice(w.field.undo.length).trim();
  };
  it('words every kind in EN and TR: edit unverified, shell unknown, destructive shell irreversible, fetch no change, MCP as its server declares', () => {
    const cases: [Partial<WorklineApproval>, string, string][] = [
      [{ tool: 'edit_file', target: 'a', risk: 'edit', undo: 'unverified' }, 'Not checked — Deckent does not keep the earlier content', 'Kontrol edilmedi — Deckent önceki içeriği saklamıyor'],
      [{ tool: 'write_file', target: 'a', risk: 'edit-floor' }, 'Not checked — Deckent does not keep the earlier content', 'Kontrol edilmedi — Deckent önceki içeriği saklamıyor'],
      [{ tool: 'run_shell', target: 'npm test', risk: 'shell-other-modify', undo: 'may-change' }, 'Unknown (it can change the system)', 'Bilinmiyor (sistemi değiştirebilir)'],
      [{ tool: 'run_shell', target: 'rm -rf b', risk: 'shell-destructive', undo: 'irreversible' }, 'No — it cannot be undone', 'Hayır — geri alınamaz'],
      [{ tool: 'fetch_url', target: 'https://x.org', risk: 'fetch-unlisted', undo: 'no-change' }, 'Nothing to undo — it changes nothing', 'Geri alınacak bir şey yok — değişiklik yapmaz'],
      [{ tool: 'mcp__docs__query', target: null, risk: 'mcp-call', undo: 'server-read-only' }, 'The server says it changes nothing (read-only)', 'Sunucu bildiriyor: değişiklik yapmaz (salt okuma)'],
      [{ tool: 'mcp__fs__append', target: null, risk: 'mcp-call', undo: 'server-additive' }, 'The server says it only adds, never deletes or overwrites', 'Sunucu bildiriyor: yalnız ekler, silmez ya da üzerine yazmaz'],
      [{ tool: 'mcp__fs__rm', target: null, risk: 'mcp-floor', undo: 'server-destructive' }, 'The server says it can delete or overwrite (destructive)', 'Sunucu bildiriyor: silebilir ya da üzerine yazabilir (yıkıcı)'],
      [{ tool: 'mcp__x__y', target: null, risk: 'mcp-call', undo: 'server-silent' }, 'The server does not say', 'Sunucu bildirmiyor'],
      // A stored MCP card (no producer word): the server's declaration is not known here, so it is "not declared", never guessed.
      [{ tool: 'mcp__x__y', target: null, risk: 'mcp-call' }, 'not declared by the tool', 'araç bildirmedi'],
      // A catalog operation keeps its sealed facts.
      [{ undo: 'ops.rollback@1' }, 'Yes — a compensating operation exists (see Details)', 'Evet — telafi işlemi var (Ayrıntı\'da)'],
    ];
    for (const [patch, en, tr] of cases) {
      expect(undoOf(base(patch), 'en'), JSON.stringify(patch)).toBe(en);
      expect(undoOf(base(patch), 'tr'), JSON.stringify(patch)).toBe(tr);
    }
    // Never "reversible" for a tool call: no tool-call word in either catalog claims it.
    for (const locale of ['en', 'tr'] as const) {
      const words = workSurfaceLabels(locale).approvalWindow.undo;
      for (const key of ['unverified', 'may-change', 'irreversible', 'no-change', 'server-read-only', 'server-additive', 'server-destructive', 'server-silent'] as const) {
        expect(words[key]).not.toMatch(/^(Yes|Evet)\b/u);
      }
    }
    // A tool-call word never adds a compensation detail line.
    expect(approvalCardLines(base(cases[0]![0]), workSurfaceLabels('en'), undefined, null, {}, NOW).join('\n')).not.toContain(workSurfaceLabels('en').approvalWindow.detail.compensation.split('{')[0]!);
  });

  it('words the posture: host, a degraded sandbox, a passed-over realm, an open view and an unknown realm id', () => {
    const shell = (posture: NonNullable<WorklineApproval['posture']>) => base({ tool: 'run_shell', target: 'make', risk: 'shell-other-modify', posture });
    const rows = (approval: WorklineApproval, locale: 'en' | 'tr') => approvalCardLines(approval, workSurfaceLabels(locale), '$ make\nrisk: modify (x)\nENGINE SENTENCE', 'make', {}, NOW).join('\n');
    const host = shell({ realm: 'host', containment: 'host', project: 'writable', git: 'writable', network: 'reachable', passedOver: ['bubblewrap', 'landlock'] });
    expect(rows(host, 'en')).toContain('On this machine as your user — not a sandbox: files, processes and the network are reachable');
    expect(rows(host, 'tr')).toContain('Bu makinede senin kullanıcınla — sandbox değil: dosyalar, süreçler ve ağ erişilebilir');
    expect(rows(host, 'tr')).toContain('Tercih edilen sandbox kullanılamadı: bubblewrap, landlock');
    const degraded = shell({ realm: 'landlock', containment: 'degraded', project: 'read-only', git: 'read-only', network: 'closed', passedOver: [] });
    expect(rows(degraded, 'en')).toContain('In the landlock sandbox: the project is read-only, .git read-only, network off');
    expect(rows(degraded, 'tr')).toContain('Sandbox eksik korumalı (degraded)');
    const open = shell({ realm: 'bubblewrap', containment: 'sandbox', project: 'writable', git: 'writable', network: 'reachable', passedOver: [] });
    expect(rows(open, 'tr')).toContain('bubblewrap sandbox içinde: proje yazılabilir (korunan dosyalar dahil), .git yazılabilir, ağ açık');
    const overlay = shell({ realm: 'enterprise-vm', containment: 'sandbox', project: 'write-set', git: 'read-only', network: 'closed', passedOver: [] });
    expect(rows(overlay, 'en')).toContain('In the enterprise-vm sandbox: the project\'s writes are kept aside and applied like edits, .git read-only, network off');
    // The engine sentence is never worded into the posture rows; it stays in the producer's preview below the Preview heading.
    for (const approval of [host, degraded, open, overlay]) for (const locale of ['en', 'tr'] as const) {
      const lines = rows(approval, locale).split('\n'), heading = workSurfaceLabels(locale).approvalWindow.field.preview;
      expect(lines.findIndex(line => line.includes('ENGINE SENTENCE'))).toBeGreaterThan(lines.indexOf(heading));
    }
  });
});
