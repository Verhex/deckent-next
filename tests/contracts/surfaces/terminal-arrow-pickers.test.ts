import { afterEach, describe, expect, it } from 'vitest';
import type { WorklineApproval, WorklineProps } from '#surfaces/core/terminal/index.js';
import { mountWorkline, settle, until } from '../support/workline-harness.js';

// Argümansız /resume ve /approvals liste basmak yerine ok tuşlu seçici açar. Enter vurgulanan satırı
// mevcut yola verir (/resume <id>, onay kartı); Esc kapatır. Down sonrası Enter ilk satırı seçerse bu dosya kırmızıdır.
const DOWN = '\u001b[B', ESC = '\u001b';
const views: Array<ReturnType<typeof mountWorkline>> = [];
afterEach(() => { for (const view of views.splice(0)) view.instance.unmount(); });

async function open(props: Partial<WorklineProps> = {}, columns = 200) {
  const view = mountWorkline(props, columns);
  views.push(view);
  await until(() => view.stdout.text.includes('READY'), 'ready');
  const type = async (...chunks: string[]) => {
    for (const chunk of chunks) for (const char of chunk.startsWith(ESC) ? [chunk] : [...chunk]) {
      // A rendered frame precedes passive useInput subscription changes. Await Ink's documented flush before the next key.
      await view.instance.waitUntilRenderFlush();
      view.stdin.write(char); await settle(chunk === ESC ? 40 : 3);
    }
    await view.instance.waitUntilRenderFlush();
  };
  return { ...view, type, frame: () => view.stdout.frame };
}

const FIRST_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const SECOND_ID = 'bbbbbbbb-2222-4222-8222-222222222222';

function sessions() {
  const loaded: string[] = [];
  const summaries = [
    { sessionId: FIRST_ID, updatedAtMs: 1_700_000_000_000, messages: 1, preview: 'PREVIEW-TOKEN-FIRST' },
    { sessionId: SECOND_ID, updatedAtMs: 1_700_000_100_000, messages: 3, preview: 'PREVIEW-TOKEN-SECOND' },
  ];
  const port = {
    async save() { /* unused */ },
    async list() { return summaries; },
    async load(id: string) {
      loaded.push(id);
      if (id === SECOND_ID) return [{ role: 'user' as const, content: 'from-second' }, { role: 'assistant' as const, content: 'a2', toolCalls: [] },
        { role: 'assistant' as const, content: 'a3', toolCalls: [] }];
      if (id === FIRST_ID) return [{ role: 'user' as const, content: 'from-first' }];
      return null;
    },
  };
  return { loaded, props: { sessions: port } satisfies Partial<WorklineProps> };
}

function approval(id: string): WorklineApproval {
  return { approvalId: id, runId: 'run-1', taskId: 'task-1', summary: `summary ${id}`, requester: 'svc', revision: 0, status: 'pending', decision: null,
    expiresAt: Date.now() + 600_000 };
}

function approvals() {
  const records = [approval('ap-1'), approval('ap-2')];
  const ledger = {
    workerHeartbeatMs: 60_000,
    async listApprovalPage() { return { items: records, nextAfter: null }; },
    async decideApproval(target: { approvalId: string; revision: number }, decision: 'allow' | 'deny') {
      return { ...records.find(item => item.approvalId === target.approvalId)!, status: 'decided' as const, revision: 1, decision };
    },
  };
  return { props: { ledger, pollMs: 60_000 } satisfies Partial<WorklineProps> };
}

describe('arrow pickers for /resume and /approvals', () => {
  it('Down then Enter resumes the highlighted session, not the first', async () => {
    const fake = sessions();
    const view = await open(fake.props);
    await view.type('/resume\r');
    await until(() => view.frame().includes('> SESSION 1 aaaaaaaa 1 PREVIEW-TOKEN-FIRST') && view.frame().includes('  SESSION 2 bbbbbbbb'), 'picker');
    expect(view.frame()).not.toContain('RESUMED');
    await view.type(DOWN);
    await until(() => view.frame().includes('> SESSION 2 bbbbbbbb 3 PREVIEW-TOKEN-SECOND'), 'second row');
    expect(view.frame()).not.toContain('> SESSION 1');
    await view.type('\r');
    await until(() => view.frame().includes('RESUMED 3 bbbbbbbb'), 'second session resumed');
    expect(fake.loaded).toEqual([SECOND_ID]);
    expect(view.stdout.text).not.toContain('RESUMED 1 aaaaaaaa');
  });

  it('Esc closes the session picker and leaves the composer able to type', async () => {
    const fake = sessions();
    const view = await open(fake.props);
    await view.type('/resume\r');
    await until(() => view.frame().includes('> SESSION 1 aaaaaaaa'), 'picker');
    await view.type(ESC);
    await until(() => !view.frame().includes('> SESSION 1') && view.frame().includes('> |'), 'picker closed');
    expect(fake.loaded).toEqual([]);
    await view.type('hi');
    await until(() => view.frame().includes('> hi'), 'composer owns the keys again');
  });

  it('Down then Enter opens the highlighted approval card, not the first', async () => {
    const view = await open(approvals().props);
    await view.type('/approvals\r');
    await until(() => view.frame().includes('> A-ITEM 1 ap-1') && view.frame().includes('  A-ITEM 2 ap-2'), 'picker');
    expect(view.frame()).not.toContain('A-PROMPT');
    await view.type(DOWN);
    await until(() => view.frame().includes('> A-ITEM 2 ap-2'), 'second approval');
    await view.type('\r');
    await until(() => view.frame().includes('A-SUBJECT ap-2 run-1 task-1 svc') && view.frame().includes('A-PROMPT'), 'second card');
    expect(view.frame()).not.toContain('A-SUBJECT ap-1');
  });

  it('Esc closes the approval picker without opening a card', async () => {
    const view = await open(approvals().props);
    await view.type('/approvals\r');
    await until(() => view.frame().includes('> A-ITEM 1 ap-1'), 'picker');
    await view.type(ESC);
    await until(() => !view.frame().includes('A-ITEM 1') && !view.frame().includes('A-PROMPT'), 'closed');
  });

  it('typed /resume 2 after Esc still loads that session through the stored index', async () => {
    const fake = sessions();
    const view = await open(fake.props);
    await view.type('/resume\r');
    await until(() => view.frame().includes('> SESSION 1 aaaaaaaa'), 'picker');
    await view.type(ESC);
    await until(() => view.frame().includes('> |'), 'closed');
    await view.type('/resume 2\r');
    await until(() => view.frame().includes('RESUMED 3 bbbbbbbb'), 'typed index');
    expect(fake.loaded).toEqual([SECOND_ID]);
  });

  it('a narrow terminal still opens the picker and Enter resumes the highlighted session', async () => {
    const fake = sessions();
    const view = await open(fake.props, 16);
    await view.type('/resume\r');
    await until(() => view.frame().includes('> SESSION'), 'picker on a narrow screen');
    expect(view.frame()).not.toContain('PREVIEW-TOKEN-FIRST');
    await view.type(DOWN, '\r');
    // A 16-column screen wraps the notice; the words stay, they are not dropped.
    await until(() => view.stdout.text.includes('RESUMED 3') && view.stdout.text.includes('bbbbbbbb'), 'highlighted session resumed');
    expect(fake.loaded).toEqual([SECOND_ID]);
  });
});
